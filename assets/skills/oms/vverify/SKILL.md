---
name: vverify
description: Verify UI changes through visual comparison and consistency checking.
---

# OMS Visual Verification Skill

This skill verifies UI changes through visual comparison, consistency checking, and layout validation. Use this when frontend changes have been made and you need to confirm visual correctness.

## When to Use

- After implementing or modifying UI components
- When responsive behavior needs to be validated
- After CSS/styling changes
- When refactoring component structure
- Before deploying frontend changes to production

## Procedure

### Step 1: Identify What Changed

Determine which UI components were modified:
1. Use `terminal-execute` to run `git diff --name-only` to find changed files
2. Filter for frontend files (.tsx, .jsx, .vue, .html, .css, .scss)
3. For each changed file, read it with `filesystem-read` to understand the changes
4. Identify which visual components or pages are affected

### Step 2: Define Verification Checkpoints

For each affected component, define what to verify:

1. **Layout** — Is the component positioned correctly within its parent?
2. **Spacing** — Are margins, padding, and gaps consistent with the design system?
3. **Typography** — Are font sizes, weights, and colors correct?
4. **Colors** — Do background, text, border, and accent colors match the design tokens?
5. **Responsiveness** — Does the layout work at mobile, tablet, and desktop breakpoints?
6. **States** — Are hover, focus, active, and disabled states styled correctly?
7. **Accessibility** — Are contrast ratios sufficient? Are focus indicators visible?

### Step 3: Check Visual Consistency

Compare the changed components against existing ones:

1. **Design tokens** — Verify colors, spacing, and typography use CSS variables/design tokens, not hardcoded values
2. **Component patterns** — Ensure similar components follow the same structure (e.g., all buttons have the same base styles)
3. **Spacing rhythm** — Verify consistent vertical and horizontal spacing across the page
4. **Icon usage** — Check that icons are from the same icon set and sized consistently
5. **Alignment** — Verify text and elements align to the grid or flexbox baseline

### Step 4: Validate Cross-Browser/Cross-Device

Without actual browser access, validate through code analysis:

1. **CSS compatibility** — Check for use of modern CSS features and note browser support
2. **Vendor prefixes** — Ensure necessary prefixes are present (or that autoprefixer is configured)
3. **Responsive breakpoints** — Verify media queries cover the target breakpoints
4. **Touch targets** — Ensure interactive elements have adequate tap target size (min 44x44px)

### Step 5: Check for Visual Regressions

Identify potential visual regressions from the changes:

1. **Overridden styles** — Check if new CSS overrides existing styles that affect other components
2. **Removed classes** — Verify that removing CSS classes doesn't break other components using them
3. **Layout shifts** — Check if component size changes could cause layout shifts
4. **Z-index conflicts** — Verify z-index values don't conflict with modals, dropdowns, etc.

### Step 6: Produce Verification Report

Compile findings into a structured report.

## Output Format

```
# Visual Verification Report

## Components Verified
- [ComponentName] (file.tsx) — Changed
- [AnotherComponent] (file.tsx) — Indirectly affected

## Checkpoints

### Layout ✅/⚠️/❌
[Findings for each checkpoint]

### Spacing ✅/⚠️/❌
[Findings]

### Typography ✅/⚠️/❌
[Findings]

### Colors ✅/⚠️/❌
[Findings]

### Responsiveness ✅/⚠️/❌
[Findings]

### States ✅/⚠️/❌
[Findings]

### Accessibility ✅/⚠️/❌
[Findings]

## Consistency Issues
[List of inconsistencies with the design system]

## Visual Regression Risks
[List of potential regressions]

## Recommendations
[Prioritized list of fixes]
```

## Rules

- Always verify against the existing design system/tokens, not just the changed code
- Flag hardcoded values that should use design tokens
- Check accessibility even if not explicitly requested
- If a screenshot is available, compare it against the code expectations
- Never mark something as passing without evidence
