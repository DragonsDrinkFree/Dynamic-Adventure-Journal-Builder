import { BuilderApp } from "./builder-app.js";
import { RuleManager } from "./rule-manager.js";
import { PDFParser } from "./pdf-parser.js";
import { JournalCreator } from "./journal-creator.js";

const MODULE_ID = "dynamic-adventure-journal-builder";

// ── Module init ────────────────────────────────────────────────────────────

Hooks.once("init", () => {
  console.log("Dynamic Adventure Journal Builder | Initialising…");
  // Expose classes on the global DAJB namespace so they're reachable from the
  // browser console for debugging (e.g. DAJB.PDFParser.debugColumns = true).
  globalThis.DAJB = { PDFParser, RuleManager, JournalCreator, BuilderApp };

  // Per-user flag controlling the welcome dialog. config:true also surfaces it in
  // Configure Settings so a user can re-enable the popup after dismissing it.
  game.settings.register(MODULE_ID, "hideWelcome", {
    name: "Hide welcome message",
    hint: "Don't show the Dynamic Adventure Journal Builder welcome dialog again.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
  });
});

// ── Journal sidebar button ─────────────────────────────────────────────────

Hooks.on("renderJournalDirectory", (app, html, data) => {
  // In FoundryVTT v13 `html` may be a plain HTMLElement rather than jQuery.
  // Normalise to an HTMLElement.
  const root = html instanceof HTMLElement ? html : html[0];
  if (!root) return;

  // The header actions area where "Create Entry" and "Create Folder" live.
  const headerActions =
    root.querySelector(".directory-header .header-actions") ??
    root.querySelector(".directory-header .action-buttons") ??
    root.querySelector(".directory-header");

  if (!headerActions) {
    console.warn("DAJB | Could not find header-actions in JournalDirectory");
    return;
  }

  // Avoid adding the button twice on re-renders
  if (headerActions.querySelector(".dajb-open-builder")) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "dajb-open-builder";
  btn.title = "Build Adventure Journal";
  btn.innerHTML = '<i class="fas fa-book-open"></i> Build Adventure Journal';
  btn.addEventListener("click", () => {
    // Singleton-ish: re-use existing window if open
    const existing = Object.values(foundry.applications.instances ?? {}).find(
      (a) => a.id === "dajb-builder"
    );
    if (existing) {
      existing.bringToFront?.();
      return;
    }
    new BuilderApp().render(true);
  });

  headerActions.appendChild(btn);
});

// ── Welcome dialog ──────────────────────────────────────────────────────────

// Show the welcome dialog to GMs on every world load until they tick "do not show
// again". Closing without ticking the box leaves the flag untouched, so it reappears.
Hooks.once("ready", () => {
  if (!game.user?.isGM) return;
  if (game.settings.get(MODULE_ID, "hideWelcome")) return;
  showWelcomeDialog();
});

function showWelcomeDialog() {
  const content = `
    <div class="dajb-welcome">
      <div class="dajb-welcome-body">
        <p><strong>Welcome to The Dynamic Adventure Journal Builder!</strong></p>
        <p>This module is incredibly powerful, but has a steep learning curve. To help ease the process of learning please visit:
          <a href="https://wiki.dragonsdrinkfree.com/en/modules/dynamic-adventure-journal-builder" target="_blank" rel="noopener">Wiki</a></p>
        <p>Additional help can be found on our
          <a href="https://discord.gg/f82QmgudTb" target="_blank" rel="noopener">Discord</a>.</p>
      </div>
      <div class="dajb-welcome-footer">
        <a class="dajb-welcome-patreon" href="https://www.patreon.com/dragonsdrinkfree" target="_blank" rel="noopener">Support me on Patreon</a>
        <label class="dajb-welcome-dismiss">
          <span>Do not show again</span>
          <input type="checkbox" name="dajbHideWelcome" />
        </label>
      </div>
    </div>`;

  foundry.applications.api.DialogV2.prompt({
    window: { title: "Dynamic Adventure Journal Builder" },
    content,
    ok: {
      label: "Got it",
      callback: (_ev, button) => {
        const cb = button.form?.elements?.dajbHideWelcome;
        if (cb?.checked) game.settings.set(MODULE_ID, "hideWelcome", true);
      },
    },
    rejectClose: false,
  });
}
