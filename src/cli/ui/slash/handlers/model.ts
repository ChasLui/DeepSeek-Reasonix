import type { BudgetScope } from "@/budget/window.js";
import {
  clearBudgetWindows,
  resolveBudgetWindows,
  saveBudgetWindow,
  savePreset,
} from "@/config.js";
import { t } from "@/i18n/index.js";
import { PRESETS } from "../../presets.js";
import type { SlashHandler } from "../dispatch.js";

function inferPresetFromModel(id: string): "auto" | "flash" | "pro" | null {
  if (id === "deepseek-v4-pro") return "pro";
  if (id === "deepseek-v4-flash") return "flash";
  return null;
}

const model: SlashHandler = (args, loop, ctx) => {
  const id = args[0];
  const known = ctx.models ?? null;
  if (!id) {
    return { openModelPicker: true };
  }
  // Manual model pick = explicit pin: disable auto-escalate so flash doesn't
  // get bumped, and persist the inferred preset so a relaunch keeps the choice.
  loop.configure({ model: id, autoEscalate: false });
  ctx.dispatch?.({ type: "session.model.change", model: id });
  const inferred = inferPresetFromModel(id);
  ctx.dispatch?.({ type: "session.preset.change", preset: inferred });
  if (inferred) {
    try {
      savePreset(inferred);
    } catch {
      /* disk full / perms — runtime change still took effect */
    }
  }
  if (known && known.length > 0 && !known.includes(id)) {
    return {
      info: t("handlers.model.modelNotInCatalog", {
        id,
        list: known.join(", "),
      }),
    };
  }
  return { info: t("handlers.model.modelSet", { id }) };
};

const preset: SlashHandler = (args, loop, ctx) => {
  const name = (args[0] ?? "").toLowerCase();
  const apply = (
    presetName: "auto" | "flash" | "pro",
    p: (typeof PRESETS)[keyof typeof PRESETS],
  ) => {
    loop.configure({
      model: p.model,
      autoEscalate: p.autoEscalate,
      reasoningEffort: p.reasoningEffort,
    });
    ctx.dispatch?.({ type: "session.model.change", model: p.model });
    ctx.dispatch?.({ type: "session.preset.change", preset: presetName });
    try {
      savePreset(presetName);
    } catch {
      /* disk full / perms — runtime change still took effect */
    }
  };
  if (name === "auto") {
    apply("auto", PRESETS.auto);
    return { info: t("handlers.model.presetAuto") };
  }
  if (name === "flash") {
    apply("flash", PRESETS.flash);
    return { info: t("handlers.model.presetFlash") };
  }
  if (name === "pro") {
    apply("pro", PRESETS.pro);
    return { info: t("handlers.model.presetPro") };
  }
  if (name === "") {
    return { openModelPicker: true };
  }
  return { info: t("handlers.model.presetUsage") };
};

const ESCALATION_MODEL_ID = "deepseek-v4-pro";

const pro: SlashHandler = (args, loop, ctx) => {
  const arg = (args[0] ?? "").toLowerCase();
  if (arg === "off" || arg === "cancel" || arg === "disarm") {
    if (!loop.proArmed) {
      return { info: t("handlers.model.proNothingArmed") };
    }
    if (ctx.disarmPro) ctx.disarmPro();
    else loop.disarmPro();
    return { info: t("handlers.model.proDisarmed") };
  }
  if (arg && arg !== "on" && arg !== "arm") {
    return { info: t("handlers.model.proUsage") };
  }
  if (ctx.armPro) ctx.armPro();
  else loop.armProForNextTurn();
  return {
    info: t("handlers.model.proArmed", { model: ESCALATION_MODEL_ID }),
  };
};

const budget: SlashHandler = (args, loop) => {
  const arg = args[0]?.trim() ?? "";
  if (arg === "window") {
    const a1 = args[1]?.trim() ?? "";
    if (a1 === "") {
      const statuses = loop.budgetWindowStatuses();
      if (statuses.length === 0) return { info: t("handlers.model.budgetWindowNone") };
      return {
        info: statuses
          .map((s) =>
            t("handlers.model.budgetWindowStatus", {
              scope: s.scope,
              period: s.period,
              spent: s.spentUsd.toFixed(4),
              cap: s.capUsd.toFixed(2),
              remaining: s.remainingUsd.toFixed(4),
            }),
          )
          .join("\n"),
      };
    }
    // Bare `off` clears every window (both scopes).
    if (a1 === "off" || a1 === "none" || a1 === "0") {
      clearBudgetWindows();
      loop.setBudgetWindows([]);
      return { info: t("handlers.model.budgetWindowOff") };
    }
    // Optional scope token: `/budget window workspace daily 5` (default global).
    let scope: BudgetScope = "global";
    let periodIdx = 1;
    if (a1 === "global" || a1 === "workspace") {
      scope = a1;
      periodIdx = 2;
    }
    const period = (args[periodIdx] ?? "").trim();
    if (period !== "daily" && period !== "weekly" && period !== "monthly") {
      return {
        info: t("handlers.model.budgetWindowUsage", {
          arg: args.slice(1).join(" "),
        }),
      };
    }
    const capArg = (args[periodIdx + 1] ?? "").trim();
    if (capArg === "off" || capArg === "none" || capArg === "0") {
      saveBudgetWindow(period, null, scope);
      loop.setBudgetWindows(resolveBudgetWindows());
      return { info: t("handlers.model.budgetWindowOff") };
    }
    const capUsd = Number(capArg.replace(/^\$/, ""));
    if (!Number.isFinite(capUsd) || capUsd <= 0) {
      return {
        info: t("handlers.model.budgetWindowUsage", {
          arg: args.slice(1).join(" "),
        }),
      };
    }
    saveBudgetWindow(period, capUsd, scope);
    loop.setBudgetWindows(resolveBudgetWindows());
    const set = loop.budgetWindowStatuses().find((s) => s.period === period && s.scope === scope);
    return {
      info: t("handlers.model.budgetWindowSet", {
        scope,
        period,
        cap: capUsd.toFixed(2),
        spent: (set?.spentUsd ?? 0).toFixed(4),
      }),
    };
  }
  if (arg === "") {
    if (loop.budgetUsd === null) {
      return { info: t("handlers.model.budgetNoCap") };
    }
    const spent = loop.stats.totalCost;
    const pct = (spent / loop.budgetUsd) * 100;
    return {
      info: t("handlers.model.budgetStatus", {
        spent: spent.toFixed(4),
        cap: loop.budgetUsd.toFixed(2),
        pct: pct.toFixed(1),
      }),
    };
  }
  if (arg === "off" || arg === "none" || arg === "0") {
    loop.setBudget(null);
    return { info: t("handlers.model.budgetOff") };
  }
  const cleaned = arg.replace(/^\$/, "");
  const usd = Number(cleaned);
  if (!Number.isFinite(usd) || usd <= 0) {
    return { info: t("handlers.model.budgetUsage", { arg }) };
  }
  loop.setBudget(usd);
  const spent = loop.stats.totalCost;
  if (spent >= usd) {
    return {
      info: t("handlers.model.budgetExhausted", {
        cap: usd.toFixed(2),
        spent: spent.toFixed(4),
      }),
    };
  }
  return {
    info: t("handlers.model.budgetSet", {
      cap: usd.toFixed(2),
      spent: spent.toFixed(4),
    }),
  };
};

export const handlers: Record<string, SlashHandler> = {
  model,
  preset,
  pro,
  budget,
};
