# TML-563 UI/UX HOLD Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** Resolve UI/UX review findings 1-9 from `main@51863fb`, add regression coverage, and provide the reviewer's desktop/mobile screenshot matrix for re-review.

**Architecture:** Introduce one portal-based modal primitive that owns focus trapping, Escape handling, opener restoration, and application isolation. Make the Studio root the responsive container, switch narrow embeds to explicit scene/object/properties tabs, keep primary actions in one row with an accessible overflow menu, and collapse the demo host log on small screens. Preserve editing behavior while replacing inaccessible timeline/tree interactions with named native controls, consistent Lucide icons, semantic disabled colors, and shared plugin visual tokens.

**Tech Stack:** React 19, TypeScript, CSS container queries, Lucide React, Vitest/Testing Library, Playwright, axe-core.

---

### Task 1: Modal focus boundary

**Files:**
- Create: `packages/studio/src/components/ModalDialog.tsx`
- Create: `packages/studio/test/modal-dialog.test.tsx`
- Modify: `packages/studio/src/components/PluginManager.tsx`
- Modify: `packages/studio/src/components/CommandPalette.tsx`
- Modify: `packages/studio/src/components/LumoraStudio.tsx`
- Test: `e2e/ui-ux-regression.spec.ts`

1. Write tests for `aria-modal`, portal placement, initial focus, Tab/Shift+Tab wrapping, Escape, outside-key isolation, and opener restoration.
2. Run the focused tests and confirm they fail on the existing dialogs.
3. Implement `ModalDialog`, render plugin/command dialogs through it, and set the Studio application root inert while either dialog is open.
4. Add a persistent command-search label and rerun the focused tests until green.

### Task 2: Container-responsive editor and compact host

**Files:**
- Modify: `packages/studio/src/components/LumoraStudio.tsx`
- Modify: `packages/studio/src/components/Toolbar.tsx`
- Modify: `packages/studio/src/lumora.css`
- Modify: `examples/embedded-host/src/App.tsx`
- Modify: `examples/embedded-host/src/app.css`
- Test: `e2e/ui-ux-regression.spec.ts`

1. Add E2E assertions for 900/760/600/560/480px Studio widths, stable scene height, no horizontal overflow, one-row primary actions, panel tab switching, and collapsed mobile host log.
2. Run the E2E file and confirm the current viewport-based layout fails.
3. Make `.lumora-studio` the inline-size container, replace editor `@media` layout rules with `@container`, and add scene/object/properties tabs below 900px.
4. Move secondary toolbar actions into an accessible narrow-container overflow menu and make the host log a user-controlled drawer below 900px.
5. Use `100dvh` and stable tracks so 375x667 and 667x375 preserve a usable scene viewport.

### Task 3: Accessible names and keyboard timeline

**Files:**
- Modify: `packages/studio/test/editor-components.test.tsx`
- Modify: `packages/studio/test/timeline-panel.test.tsx`
- Modify: `packages/studio/src/components/editor/ObjectTree.tsx`
- Modify: `packages/studio/src/components/editor/EditorViewport.tsx`
- Modify: `packages/studio/src/components/editor/PropertiesPanel.tsx`
- Modify: `packages/studio/src/components/editor/TimelinePanel.tsx`
- Test: `e2e/accessibility.spec.ts`

1. Add failing accessible-name assertions for the scene selector, view selector, object-name input, and command search.
2. Add failing keyboard tests for ruler Arrow/Page/Home/End seeking, track selection, and shot seeking.
3. Add labels, expose the ruler as a slider, and use separate native buttons for track/shot actions without nested interactive controls.
4. Expand editor-state axe scans so the main editor and dialogs are checked instead of only the inert export workspace.

### Task 4: Targets, contrast, and icon language

**Files:**
- Modify: `packages/studio/package.json`
- Modify: `package-lock.json`
- Modify: `packages/studio/src/components/editor/ObjectTree.tsx`
- Modify: `packages/studio/src/components/editor/TimelinePanel.tsx`
- Modify: `packages/studio/src/components/storyboard/StoryboardWorkspace.tsx`
- Modify: `packages/studio/src/components/PluginManager.tsx`
- Modify: `packages/studio/src/components/Toolbar.tsx`
- Modify: `packages/studio/src/lumora.css`
- Test: `packages/studio/test/editor-components.test.tsx`
- Test: `packages/studio/test/timeline-panel.test.tsx`

1. Add failing assertions for dynamic action names, pressed states, and icon-only control labels.
2. Add `lucide-react`, replace Unicode glyphs and single-character action abbreviations, and hide icons from the accessibility tree.
3. Keep visual keyframe dots at 8px while expanding hit boxes to 24px desktop and 44px touch; give tree and shot actions equivalent stable targets.
4. Remove whole-row disabled opacity, use readable state tokens, and keep tree actions visible without hover.

### Task 5: Mock plugin visual baseline

**Files:**
- Create: `examples/mock-plugin/src/style.css`
- Modify: `examples/mock-plugin/src/index.tsx`
- Modify: `examples/mock-plugin/src/panels/MockConsolePanel.tsx`
- Modify: `examples/mock-plugin/src/panels/MockAiChatPanel.tsx`
- Test: `e2e/ui-ux-regression.spec.ts`

1. Add a failing browser assertion that Mock controls inherit the Studio surface, text, border, focus, and disabled tokens.
2. Add plugin-owned semantic styles for headings, actions, inputs, results, empty states, and log rows.
3. Rerun the visual and accessibility scenarios until green.

### Task 6: Verification and evidence

**Files:**
- Modify: `e2e/ui-ux-regression.spec.ts`
- Generate: `test-results/tml-563-after/*.png`

1. Capture the editor at 1440x900 and 1024x768; plugin manager, command palette, storyboard, and export at 1440x900; editor/plugin/storyboard at 375x667; and editor/export at 667x375.
2. Run focused Vitest and Chromium E2E, then `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check`.
3. Compare screenshots against the review attachments and inspect the critical desktop/mobile images directly.
4. Commit, push an independent `TML-563` branch, create a linked PR without merging, and report the PR, tests, screenshots, and residual limits to the project manager.
