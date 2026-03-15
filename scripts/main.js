import { BuilderApp } from "./builder-app.js";
import { RuleManager } from "./rule-manager.js";
import { PDFParser } from "./pdf-parser.js";
import { JournalCreator } from "./journal-creator.js";

// ── Module init ────────────────────────────────────────────────────────────

Hooks.once("init", () => {
  console.log("Dynamic Adventure Journal Builder | Initialising…");
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
