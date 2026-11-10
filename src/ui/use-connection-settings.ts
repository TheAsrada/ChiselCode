import { useEffect, useRef, useState } from "react";
import { ProfileIdSchema } from "../config/schema.js";
import type {
  ConnectionChallenge,
  ProviderDefinition,
  ProviderProfile,
} from "../providers/contracts.js";
import { createBuiltinProviderRegistry } from "../providers/runtime.js";
import { useSettingsAutosave } from "./settings-autosave.js";
import {
  type OpenTuiSettingsActions,
  type Screen,
  safeNotice,
  type Work,
} from "./settings-contracts.js";
import { type TuiSettingsValues } from "./settings-values.js";
import { FAIL_MARK } from "./theme.js";
import { useConnectionSettingsModel } from "./use-connection-settings-model.js";

export function useConnectionSettings({
  actions,
  initialSelection,
  onOpenContent,
}: {
  actions?: OpenTuiSettingsActions;
  initialSelection: number;
  onOpenContent(): void;
}) {
  const [values, setValues] = useState<TuiSettingsValues>({
    provider: "",
    model: "",
  });

  const [providers, setProviders] = useState<ProviderDefinition[]>(() =>
    createBuiltinProviderRegistry().list(),
  );

  const [profiles, setProfiles] = useState<Record<string, ProviderProfile>>({});

  const [hasKey, setHasKeyState] = useState(false);

  const readiness = useRef(false);

  const setHasKey = (ready: boolean) => {
    readiness.current = ready;
    setHasKeyState(ready);
  };

  const [loaded, setLoaded] = useState(!actions);

  const authAbort = useRef<AbortController | undefined>(undefined);

  const [challenge, setChallenge] = useState<ConnectionChallenge>();

  const [accountLabel, setAccountLabel] = useState<string>();

  const [connectionConfirm, setConnectionConfirm] = useState<{
    type: "delete" | "disconnect";
    profileId: string;
  }>();

  const [connectionChoice, setConnectionChoice] = useState(0);

  const [addingProfile, setAddingProfile] = useState(false);

  const [screen, setScreen] = useState<Screen>("menu");

  const [selected, setSelectedState] = useState(initialSelection);

  const selectedRef = useRef(initialSelection);

  const setSelected = (value: number | ((current: number) => number)) => {
    const next =
      typeof value === "function" ? value(selectedRef.current) : value;
    selectedRef.current = next;
    setSelectedState(next);
  };

  const [query, setQuery] = useState("");

  const [models, setModels] = useState<Array<{ id: string; hint?: string }>>(
    [],
  );

  const [editing, setEditing] = useState("");

  const [notice, setNotice] = useState("");

  const [noticeKind, setNoticeKind] = useState<"error" | "success" | "info">(
    "info",
  );

  const [busy, setBusy] = useState<Work>();

  const lifetime = useRef({
    mounted: true,
    operation: 0,
    busy: undefined as Work | undefined,
  });

  const baseline = useRef("");

  const editorEpoch = useRef(0);

  const acknowledged = useRef<TuiSettingsValues | undefined>(undefined);

  const valuesRef = useRef(values);

  valuesRef.current = values;
  const {
    definition,
    subscription,
    rows,
    menuIndex,
    filteredProviders,
    choices,
    choiceIndex,
    selector,
    field,
    fieldDirty,
    dirty,
  } = useConnectionSettingsModel({
    providers,
    values,
    hasKey,
    accountLabel,
    profiles,
    selected,
    query,
    models,
    screen,
    editing,
    loaded,
    baseline: baseline.current,
    actions,
  });

  const setMessage = (
    text: string,
    kind: "error" | "success" | "info" = "info",
  ) => {
    setNotice(text);
    setNoticeKind(kind);
  };

  const run = (kind: Work, work: (valid: () => boolean) => Promise<void>) => {
    if (lifetime.current.busy) return;
    const operation = ++lifetime.current.operation;
    lifetime.current.busy = kind;
    setBusy(kind);
    setNotice("");
    const valid = () =>
      lifetime.current.mounted && operation === lifetime.current.operation;
    void work(valid)
      .catch((error) => {
        if (valid())
          setMessage(
            safeNotice(error, valuesRef.current, editing, screen === "key"),
            "error",
          );
      })
      .finally(() => {
        if (valid()) {
          lifetime.current.busy = undefined;
          setBusy(undefined);
        }
      });
  };

  const cancelWork = () => {
    authAbort.current?.abort();
    authAbort.current = undefined;
    setChallenge(undefined);
    ++lifetime.current.operation;
    lifetime.current.busy = undefined;
    setBusy(undefined);
  };

  const load = () => {
    if (!actions) return;
    run("load", async (valid) => {
      const [draft, catalog] = await Promise.all([
        actions.load(),
        actions.catalog?.(),
      ]);
      if (!valid()) return;
      if (catalog) {
        setProviders(catalog.providers);
        setProfiles(catalog.profiles);
      }
      setValues(draft.values);
      baseline.current = JSON.stringify(draft.values);
      acknowledged.current = draft.values;
      setHasKey(draft.hasKey);
      setAccountLabel(draft.accountLabel);
      setLoaded(true);
      setScreen("profiles");
    });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: Load once for each actions object; previews must not reload connection drafts.
  useEffect(() => {
    lifetime.current.mounted = true;
    load();
    return () => {
      authAbort.current?.abort();
      lifetime.current.mounted = false;
      ++lifetime.current.operation;
    };
  }, [actions]);

  const fieldValues = () =>
    field && screen !== "profile-id"
      ? {
          ...values,
          [screen === "profile-label"
            ? "label"
            : screen === "key"
              ? "apiKey"
              : screen === "base-url"
                ? "baseUrl"
                : "model"]: editing,
        }
      : values;

  const pendingValues = fieldDirty ? fieldValues() : values;

  const connectionAutosave = useSettingsAutosave(
    loaded &&
      values.profileId &&
      !addingProfile &&
      baseline.current !== JSON.stringify(pendingValues)
      ? JSON.stringify(pendingValues)
      : undefined,
    async () => {
      if (!actions) return;
      const next = {
        ...pendingValues,
        model: pendingValues.model.trim(),
        apiKey: pendingValues.apiKey?.trim() || undefined,
        baseUrl: pendingValues.baseUrl?.trim() || undefined,
      };
      if (!next.model) throw new Error("Введите название модели");
      if (next.baseUrl) {
        const url = new URL(next.baseUrl);
        if (!["http:", "https:"].includes(url.protocol))
          throw new Error("Адрес API должен начинаться с http:// или https://");
      }
      setMessage("Сохранение…");
      const result = await actions.save(
        next,
        next.profileId && profiles[next.profileId]
          ? acknowledged.current
          : undefined,
      );
      const saved = { ...next, apiKey: undefined };
      baseline.current = JSON.stringify(saved);
      acknowledged.current = saved;
      // A delayed response only acknowledges its snapshot, never newer typing.
      setValues((current) =>
        JSON.stringify(current) === JSON.stringify(values) ? saved : current,
      );
      setHasKey(result === "saved");
      const catalog = await actions.catalog?.();
      if (catalog) setProfiles(catalog.profiles);
      setMessage(
        result === "saved"
          ? "Сохранено · готово к работе"
          : "Сохранено · требуется настройка / авторизация",
        result === "saved" ? "success" : "info",
      );
    },
    (error) =>
      setMessage(
        safeNotice(error, pendingValues, editing, screen === "key"),
        "error",
      ),
    field ? 350 : 0,
    loaded && values.profileId && !addingProfile
      ? JSON.stringify(pendingValues)
      : undefined,
  );

  const save = (_draftValues = values, after?: () => void) => {
    void connectionAutosave.flush().then((ok) => {
      if (ok) after?.();
    });
  };

  const check = () => {
    if (!actions || !loaded) {
      if (actions) load();
      return;
    }
    run("check", async (valid) => {
      const result = await actions.check(values);
      if (valid())
        setMessage(
          safeNotice(result, values, editing, screen === "key"),
          result.startsWith(FAIL_MARK) ? "error" : "success",
        );
    });
  };

  const login = () => {
    if (!actions?.connect || !values.profileId) {
      setMessage("Сначала создайте профиль", "error");
      return;
    }
    const abort = new AbortController();
    authAbort.current?.abort();
    authAbort.current = abort;
    setScreen("login");
    setChallenge(undefined);
    run("login", async (valid) => {
      const status = await actions.connect!(values, abort.signal, (next) => {
        if (valid()) setChallenge(next);
      });
      if (!valid()) return;
      setHasKey(status.connected);
      setAccountLabel(status.label);
      setChallenge(undefined);
      const result = await actions.models(values);
      if (!valid()) return;
      setModels(result.ok ? result.models : []);
      setScreen("model-list");
      setSelected(0);
      setQuery("");
      setMessage(
        result.ok ? "Аккаунт подключён · выберите модель" : result.error,
        result.ok ? "success" : "error",
      );
    });
  };

  const switchProfile = (profileId: string) => {
    if (!actions) return;
    run("profile", async (valid) => {
      const loaded = await actions.load(profileId);
      if (!valid()) return;
      setValues(loaded.values);
      setAddingProfile(false);
      baseline.current = JSON.stringify(loaded.values);
      acknowledged.current = loaded.values;
      setHasKey(loaded.hasKey);
      setAccountLabel(loaded.accountLabel);
      setScreen("menu");
      setSelected(0);
      setQuery("");
      setNotice("");
    });
  };

  const newProfile = (discard = false) => {
    if (lifetime.current.busy || !loaded) return;
    if (!discard) {
      void connectionAutosave.flush().then((ok) => {
        if (ok) newProfile(true);
      });
      return;
    }
    setAddingProfile(true);
    setScreen("providers");
    setQuery("");
    setSelected(0);
  };

  const open = (next: Screen) => {
    onOpenContent();
    if (lifetime.current.busy || !loaded || connectionConfirm) return;
    setNotice("");
    setQuery("");
    setSelected(0);
    if (
      !values.profileId &&
      !addingProfile &&
      next !== "profiles" &&
      next !== "profile-id"
    ) {
      setScreen("profiles");
      setMessage("Нет подключений · выберите «Добавить подключение»");
      return;
    }
    if (next === "disconnect" || next === "delete-profile") {
      void connectionAutosave.flush().then((ok) => {
        if (ok && values.profileId) {
          setConnectionConfirm({
            type: next === "disconnect" ? "disconnect" : "delete",
            profileId: values.profileId,
          });
          setConnectionChoice(0);
        }
      });
      return;
    }
    if (next === "providers" && !addingProfile) {
      newProfile();
      return;
    }
    if (next === "login") {
      login();
      return;
    }
    if (next === "profile-id") {
      newProfile();
      return;
    }
    ++editorEpoch.current;
    setScreen(next);
    if (next === "providers")
      setSelected(
        Math.max(
          0,
          providers.findIndex((p) => p.id === values.provider),
        ),
      );
    setEditing(
      next === "key"
        ? (values.apiKey ?? "")
        : next === "profile-label"
          ? (values.label ?? "")
          : next === "base-url"
            ? (values.baseUrl ?? "")
            : "",
    );
    if (next === "model-list" && actions) {
      setModels([]);
      run("models", async (valid) => {
        const result = await actions.models(values);
        if (!valid()) return;
        if (result.ok) setModels(result.models);
        else setMessage(result.error, "error");
      });
    }
  };

  const back = (accepted = false) => {
    if (field && !accepted) {
      if (screen === "profile-id") {
        setScreen("profiles");
        setAddingProfile(false);
        if (acknowledged.current) setValues(acknowledged.current);
        return;
      }
      const epoch = editorEpoch.current;
      void connectionAutosave.flush().then((ok) => {
        if (ok && epoch === editorEpoch.current) {
          setValues((current) => ({ ...current, apiKey: undefined }));
          back(true);
        }
      });
      return;
    }
    if (lifetime.current.busy === "save" || lifetime.current.busy === "theme")
      return;
    ++editorEpoch.current;
    cancelWork();
    setAddingProfile(false);
    if (field) setEditing("");
    setScreen("menu");
    setSelected(
      Math.max(
        0,
        rows.findIndex(
          (r) =>
            r.screen === screen ||
            (screen === "model-manual" && r.screen === "model-list"),
        ),
      ),
    );
    setNotice("");
  };

  const acceptField = () => {
    if (screen !== "profile-id") {
      back();
      return;
    }
    let next: TuiSettingsValues;
    if (screen === "profile-id") {
      const id = editing.trim();
      if (!ProfileIdSchema.safeParse(id).success) {
        setMessage(
          "Имя: буквы, цифры, точка, дефис или _; до 128 символов",
          "error",
        );
        return;
      }
      if (profiles[id]) {
        setMessage(
          "Такой профиль уже есть. Выберите его в списке профилей.",
          "error",
        );
        return;
      }
      next = { ...values, profileId: id, label: undefined, apiKey: undefined };
      setAddingProfile(false);
      setHasKey(false);
    } else
      next = {
        ...values,
        [screen === "profile-label"
          ? "label"
          : screen === "key"
            ? "apiKey"
            : screen === "base-url"
              ? "baseUrl"
              : "model"]: editing,
      };
    setValues(next);
    back(true);
    return next;
  };

  const choose = (
    index = Math.min(selectedRef.current, choices.length - 1),
  ) => {
    if (!actions) return;
    const picked = choices[index];
    if (!picked) return;
    if (lifetime.current.busy) {
      if (lifetime.current.busy !== "models" || picked.id !== "__manual")
        return;
      cancelWork();
    }
    if (screen === "model-list") {
      if (picked.id === "__manual") {
        setEditing(query.trim() || values.model);
        setScreen("model-manual");
        setNotice("");
      } else {
        setValues((v) => ({ ...v, model: picked.id }));
        back();
      }
    } else if (screen === "profiles") {
      if (picked.id === "__new-profile") {
        newProfile();
        return;
      }
      if (picked.id === values.profileId) {
        back();
        return;
      }
      void connectionAutosave.flush().then((ok) => {
        if (ok) switchProfile(picked.id);
      });
    } else {
      const provider = filteredProviders[index];
      if (!provider) return;
      if (addingProfile) {
        setValues({
          provider: provider.id,
          model: provider.defaults.model ?? "",
          baseUrl:
            provider.auth.type !== "subscription" &&
            provider.endpoint.normalization !== "none"
              ? provider.endpoint.defaultBaseUrl
              : undefined,
        });
        setHasKey(false);
        setEditing("");
        setScreen("profile-id");
        setNotice("");
        return;
      }
      if (provider.id === values.provider) {
        back();
        return;
      }
      back();
    }
  };

  const confirmConnection = (choice: number) => {
    const pending = connectionConfirm;
    if (!pending || !choice) {
      setConnectionConfirm(undefined);
      return;
    }
    setConnectionConfirm(undefined);
    run("remove", async (valid) => {
      if (pending.type === "disconnect") await actions?.disconnect?.(values);
      else
        await actions?.removeProfile?.(
          pending.profileId,
          profiles[pending.profileId],
        );
      if (!valid()) return;
      if (pending.type === "disconnect") {
        setHasKey(false);
        setAccountLabel(undefined);
        setMessage("Аккаунт отключён");
      } else {
        const catalog = await actions?.catalog?.();
        const draft = await actions?.load();
        if (!valid()) return;
        if (catalog) setProfiles(catalog.profiles);
        if (draft) {
          setValues(draft.values);
          baseline.current = JSON.stringify(draft.values);
          acknowledged.current = draft.values;
          setHasKey(draft.hasKey);
        }
        setScreen("profiles");
        setSelected(0);
        setMessage("Профиль удалён");
      }
    });
  };
  const reloadBaseline = (message: string) => {
    void actions
      ?.load(values.profileId)
      .then((draft) => {
        acknowledged.current = draft.values;
        baseline.current = JSON.stringify(draft.values);
        setMessage(message);
      })
      .catch((error) =>
        setMessage(
          safeNotice(error, values, editing, screen === "key"),
          "error",
        ),
      );
  };
  const activate = (onReady?: () => void) => {
    void connectionAutosave.flush().then(async (ok) => {
      if (!ok) return;
      try {
        await actions?.activate?.(values);
        if (onReady && readiness.current) onReady();
        else
          setMessage(
            readiness.current
              ? "Подключение выбрано"
              : "Подключение выбрано · требуется настройка",
            "success",
          );
      } catch (error) {
        setMessage(
          safeNotice(error, values, editing, screen === "key"),
          "error",
        );
      }
    });
  };
  const working = () => lifetime.current.busy;
  const isMounted = () => lifetime.current.mounted;
  return {
    values,
    profiles,
    hasKey,
    loaded,
    challenge,
    connectionConfirm,
    setConnectionConfirm,
    connectionChoice,
    setConnectionChoice,
    screen,
    setScreen,
    selected,
    selectedRef,
    setSelected,
    query,
    setQuery,
    editing,
    setEditing,
    notice,
    setNotice,
    noticeKind,
    busy,
    working,
    isMounted,
    reloadBaseline,
    activate,
    definition,
    subscription,
    rows,
    menuIndex,
    choices,
    choiceIndex,
    selector,
    field,
    dirty,
    setMessage,
    cancelWork,
    connectionAutosave,
    save,
    check,
    login,
    switchProfile,
    newProfile,
    open,
    back,
    acceptField,
    choose,
    confirmConnection,
  };
}
