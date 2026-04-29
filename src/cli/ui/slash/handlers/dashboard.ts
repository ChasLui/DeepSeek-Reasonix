import type { SlashHandler } from "../dispatch.js";

const dashboard: SlashHandler = (args, _loop, ctx) => {
  if (!ctx.startDashboard || !ctx.getDashboardUrl) {
    return {
      info: "/dashboard is not available in this context (no startDashboard callback wired).",
    };
  }

  const sub = (args[0] ?? "").toLowerCase();

  if (sub === "stop" || sub === "off") {
    if (!ctx.stopDashboard) {
      return { info: "/dashboard stop: no stop callback wired." };
    }
    const url = ctx.getDashboardUrl();
    if (!url) return { info: "▸ dashboard is not running." };
    // Fire-and-forget the async stop. Caller (App.tsx) handles errors
    // by posting to historical.
    ctx.stopDashboard();
    return { info: "▸ dashboard stopping…" };
  }

  const existing = ctx.getDashboardUrl();
  if (existing) {
    return {
      info: [
        "▸ dashboard is already running:",
        `  ${existing}`,
        "",
        "Open it in any browser. Type `/dashboard stop` to tear it down.",
      ].join("\n"),
    };
  }

  // Boot. Slash handlers are sync; we kick the start asynchronously
  // and let App.tsx's `postInfo` deliver the URL when the server is
  // listening.
  ctx
    .startDashboard()
    .then((url) => {
      ctx.postInfo?.(
        [
          "▸ dashboard ready:",
          `  ${url}`,
          "",
          "127.0.0.1 only · token-gated. Type `/dashboard stop` to shut down.",
        ].join("\n"),
      );
    })
    .catch((err: Error) => {
      ctx.postInfo?.(`▸ dashboard failed to start: ${err.message}`);
    });

  return { info: "▸ starting dashboard server…" };
};

export const handlers: Record<string, SlashHandler> = { dashboard };
