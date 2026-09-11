#!/usr/bin/env bun
import { Command } from "commander";
import { render } from "ink";
import React from "react";
import {
  nonInteractiveResolver,
  type RunOptions,
  runPrompt,
} from "./commands/run.js";
import { CredentialStore } from "./security/credentials.js";
import type { ProviderKind } from "./types/domain.js";
import {
  createTuiApprovalResolver,
  TuiApp,
  type TuiTranscript,
} from "./ui/tui.js";

const program = new Command();
program
  .name("chisel")
  .description("A secure multi-provider coding agent")
  .version("0.1.2")
  .argument("[prompt]", "task for the coding agent")
  .option("--provider <provider>", "anthropic, openai, or openai-compatible")
  .option("--model <model>", "provider model ID")
  .option("--base-url <url>", "OpenAI-compatible API base URL")
  .option("--yes", "approve all tool actions")
  .option("--allow <tools>", "comma-separated tool allowlist")
  .option("--json", "emit one JSON result object")
  .option("--resume <session-id>", "resume an existing session")
  .option("--cwd <path>", "project directory", process.cwd())
  .action(async (prompt: string | undefined, raw: Record<string, unknown>) => {
    const options = toOptions(raw);
    if (options.provider && !isProvider(options.provider)) {
      throw new Error(`Unknown provider: ${options.provider}`);
    }
    if (!prompt) {
      if (!process.stdin.isTTY || options.json) {
        throw new Error(
          "A prompt is required outside an interactive terminal.",
        );
      }
      await startTui(options);
      return;
    }

    const { exitCode } = await runPrompt(
      prompt,
      options,
      nonInteractiveResolver,
    );
    process.exitCode = exitCode;
  });

const auth = program.command("auth").description("Manage provider credentials");
auth
  .command("set")
  .argument("<name>", "credential name, e.g. anthropic-default")
  .argument("<secret>", "API key")
  .description("Store an API key in the operating system credential store")
  .action(async (name: string, secret: string) => {
    await new CredentialStore().set(name, secret);
    process.stdout.write(`Stored credential ${name}.\n`);
  });
auth
  .command("get")
  .argument("<name>", "credential name")
  .description("Check whether a credential exists without exposing it")
  .action(async (name: string) => {
    const value = await new CredentialStore().get(name);
    process.stdout.write(
      value
        ? `Credential ${name} is available.\n`
        : `Credential ${name} was not found.\n`,
    );
    process.exitCode = value ? 0 : 1;
  });

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(
    `ChiselCode: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});

function toOptions(raw: Record<string, unknown>): RunOptions {
  return {
    provider: raw.provider as ProviderKind | undefined,
    model: raw.model as string | undefined,
    baseUrl: raw.baseUrl as string | undefined,
    yes: Boolean(raw.yes),
    allow: raw.allow as string | undefined,
    json: Boolean(raw.json),
    resume: raw.resume as string | undefined,
    cwd: raw.cwd as string | undefined,
  };
}

function isProvider(value: string): value is ProviderKind {
  return (
    value === "anthropic" || value === "openai" || value === "openai-compatible"
  );
}

async function startTui(options: RunOptions): Promise<void> {
  const resolver = createTuiApprovalResolver();
  let transcript: TuiTranscript | undefined;
  let active = false;
  const instance = render(
    React.createElement(TuiApp, {
      approvalResolver: resolver,
      bindTranscript: (nextTranscript: TuiTranscript) => {
        transcript = nextTranscript;
      },
      onSubmit: async (prompt: string) => {
        if (active || !transcript) return;
        active = true;
        transcript.append(`› ${prompt}`);
        let responseOpen = false;
        try {
          const { result } = await runPrompt(prompt, options, resolver, {
            onText: (text) => {
              if (responseOpen) transcript?.appendToLast(text);
              else transcript?.append(text);
              responseOpen = true;
            },
            onToolStart: (name, input) => {
              responseOpen = false;
              transcript?.append(`[chisel] ${name} ${JSON.stringify(input)}`);
            },
            onToolResult: (name, result) => {
              if (result.isError)
                transcript?.append(`[chisel] ${name}: ${result.output}`);
            },
          });
          if (!responseOpen)
            transcript.append(result.text || result.error || result.status);
          if (result.status === "approval_required")
            transcript.append(
              `Approval required: ${result.pendingApproval?.preview ?? "(no preview)"}`,
            );
        } catch (error) {
          transcript.append(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          active = false;
        }
      },
    }),
  );
  await instance.waitUntilExit();
}
