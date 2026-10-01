import { describe, expect, test } from "bun:test";
import { ApprovalGate, mutatesWorkspace } from "../../src/security/approval.js";
import type { ProjectConfig } from "../../src/types/domain.js";

const config: ProjectConfig = {
  allowedCommands: ["bun test"],
  deniedCommands: ["rm -rf"],
  ignorePatterns: [],
  autoApprove: false,
};

const resolver = {
  async requestApproval() {
    return "denied" as const;
  },
};

describe("ApprovalGate", () => {
  test("permission modes distinguish file edits, process, Git and external actions; denies win in every mode", () => {
    for (const [mode, expected] of [
      ["default", ["allow", "ask", "ask", "ask", "ask"]],
      ["acceptEdits", ["allow", "allow", "ask", "ask", "ask"]],
      ["dontAsk", ["allow", "deny", "deny", "deny", "deny"]],
      ["bypassPermissions", ["allow", "allow", "allow", "allow", "allow"]],
    ] as const) {
      const gate = new ApprovalGate(
        config,
        {
          approvalMode: mode,
          allowBypassPermissions: true,
          autoApprove: false,
          allowedTools: new Set(),
          nonInteractive: false,
        },
        resolver,
      );
      expect(
        ["read", "workspace_write", "process", "git_write", "external"].map(
          (effect) =>
            gate.policy.decide({ tool: "fixture", preview: "" }, effect),
        ),
      ).toEqual([...expected]);
      expect(
        gate.policy.decide(
          {
            tool: "run_shell",
            preview: "",
            command: "echo ok && rm -rf build",
          },
          "process",
        ),
      ).toBe("deny");
      expect(
        gate.policy.decide(
          { tool: "run_shell", preview: "", command: "bun test" },
          "process",
        ),
      ).toBe("allow");
    }
  });
  test("Dont ask respects narrow grants and denies other actions without consulting the resolver", async () => {
    let calls = 0;
    const gate = new ApprovalGate(
      config,
      {
        approvalMode: "dontAsk",
        autoApprove: false,
        allowedTools: new Set(["edit_file"]),
        nonInteractive: false,
      },
      {
        requestApproval: async () => {
          calls++;
          return "approved";
        },
      },
    );
    expect(await gate.decide({ tool: "edit_file", preview: "" })).toBe(
      "approved",
    );
    expect(await gate.decide({ tool: "write_file", preview: "" })).toBe(
      "denied",
    );
    expect(
      await gate.decide({
        tool: "run_shell",
        command: "bun test",
        preview: "",
      }),
    ).toBe("approved");
    expect(
      await gate.decide({
        tool: "run_shell",
        command: "bun test && echo unsafe",
        preview: "",
      }),
    ).toBe("denied");
    expect(calls).toBe(0);
  });
  test("Accept edits and legacy Auto never approve shell, Git or skill creation implicitly", async () => {
    for (const mode of ["acceptEdits", "auto"] as const) {
      const gate = new ApprovalGate(
        config,
        {
          approvalMode: mode,
          autoApprove: true,
          allowedTools: new Set(),
          nonInteractive: true,
        },
        resolver,
      );
      expect(await gate.decide({ tool: "write_file", preview: "" })).toBe(
        "approved",
      );
      for (const tool of ["run_shell", "git_commit", "create_skill"])
        expect(await gate.decide({ tool, preview: "" })).toBe("unavailable");
    }
  });
  test("Bypass needs a separate capability and disabling it revokes future approvals", async () => {
    let enabled = false;
    const gate = new ApprovalGate(
      config,
      {
        approvalMode: "bypassPermissions",
        allowBypassPermissions: () => enabled,
        autoApprove: false,
        allowedTools: new Set(),
        nonInteractive: true,
      },
      resolver,
    );
    expect(gate.policy.approvalMode).toBe("default");
    expect(await gate.decide({ tool: "run_shell", preview: "" })).toBe(
      "unavailable",
    );
    enabled = true;
    expect(await gate.decide({ tool: "run_shell", preview: "" })).toBe(
      "approved",
    );
    enabled = false;
    expect(
      gate.policy.decide(
        { tool: "run_shell", preview: "" },
        "process",
        "bypassPermissions",
      ),
    ).toBe("ask");
  });
  test("explicit Ask overrides broad --yes and config autoApprove, but retains narrow grants and hard denies", async () => {
    const gate = new ApprovalGate(
      { ...config, autoApprove: true },
      {
        approvalMode: "default",
        autoApprove: true,
        allowedTools: new Set(["edit_file", "run_shell"]),
        nonInteractive: true,
      },
      resolver,
    );
    expect(await gate.decide({ tool: "write_file", preview: "" })).toBe(
      "unavailable",
    );
    expect(await gate.decide({ tool: "edit_file", preview: "" })).toBe(
      "approved",
    );
    expect(
      await gate.decide({
        tool: "run_shell",
        preview: "",
        command: "bun test",
      }),
    ).toBe("approved");
    expect(
      await gate.decide({
        tool: "run_shell",
        preview: "",
        command: "echo ok && rm -rf build",
      }),
    ).toBe("denied");
  });
  test("enabled Bypass allows ordinary actions noninteractively but denied commands still win", async () => {
    const gate = new ApprovalGate(
      config,
      {
        approvalMode: "bypassPermissions",
        allowBypassPermissions: true,
        autoApprove: false,
        allowedTools: new Set(),
        nonInteractive: true,
      },
      resolver,
    );
    expect(await gate.decide({ tool: "create_skill", preview: "" })).toBe(
      "approved",
    );
    expect(
      await gate.decide({
        tool: "run_shell",
        preview: "",
        command: "echo ok && rm -rf build",
      }),
    ).toBe("denied");
  });
  test("auto approves read-only tools", async () => {
    const gate = new ApprovalGate(
      config,
      { autoApprove: false, allowedTools: new Set(), nonInteractive: true },
      resolver,
    );
    expect(await gate.decide({ tool: "read_file", preview: "" })).toBe(
      "approved",
    );
  });

  test("create_skill requires approval because it writes outside the project", async () => {
    const gate = new ApprovalGate(
      config,
      { autoApprove: false, allowedTools: new Set(), nonInteractive: true },
      resolver,
    );
    expect(mutatesWorkspace("create_skill")).toBe(true);
    expect(
      await gate.decide({ tool: "create_skill", preview: "release-helper" }),
    ).toBe("unavailable");
  });

  test("uses the shell allow and deny lists", async () => {
    const gate = new ApprovalGate(
      config,
      { autoApprove: false, allowedTools: new Set(), nonInteractive: true },
      resolver,
    );
    expect(
      await gate.decide({
        tool: "run_shell",
        preview: "",
        command: "bun test",
      }),
    ).toBe("approved");
    expect(
      await gate.decide({
        tool: "run_shell",
        preview: "",
        command: "rm -rf build",
      }),
    ).toBe("denied");
    expect(
      await gate.decide({
        tool: "run_shell",
        preview: "",
        command: "bun run build",
      }),
    ).toBe("unavailable");
  });
});
