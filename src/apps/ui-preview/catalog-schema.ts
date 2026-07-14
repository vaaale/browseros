// Shared, framework-free schema definitions for BOS's A2UI catalog — the
// single source of truth for both the client renderer (catalog.tsx, which
// pairs these schemas with React implementations) and the A2UI
// generation prompt (src/lib/a2ui/service.ts, which derives a compact schema
// reference from them so the sub-agent sees each component's REAL prop
// shape instead of guessing from a bare name list). No "use client"/
// "server-only" here so both sides can import it directly.

import {
  TextApi,
  ImageApi,
  IconApi,
  VideoApi,
  AudioPlayerApi,
  RowApi,
  ColumnApi,
  ListApi,
  CardApi,
  TabsApi,
  ModalApi,
  DividerApi,
  ButtonApi,
  TextFieldApi,
  CheckBoxApi,
  ChoicePickerApi,
  SliderApi,
  DateTimeInputApi,
} from "@a2ui/web_core/v0_9/basic_catalog";
import { DynamicNumberSchema, DynamicStringSchema, DynamicBooleanSchema, ActionSchema } from "@a2ui/web_core/v0_9";
import type { CatalogDefinitions } from "@copilotkit/a2ui-renderer";

// 025-ui-preview-a2ui-tools: extend the stock Tabs with an OPTIONAL controlled
// active-tab index bound to the data model, so a "Next"/"Back" Button (via a
// setData action) can drive which tab is showing — real wizard navigation, not
// just header clicks. Backward compatible: with neither field set, Tabs keeps
// its internal header-click state. Uses web_core's own (zod v3) schemas so the
// extended object stays one consistent ZodObject.
const TabsSchema = TabsApi.schema.extend({
  activeTab: DynamicNumberSchema.optional().describe(
    'Optional zero-based index of the tab to show, usually bound to the data model, e.g. {"path":"/step"}. Set this to make Next/Back buttons control the tab.',
  ),
  activeTabPath: DynamicStringSchema.optional().describe(
    'The data path activeTab is bound to (e.g. "/step"), so clicking a tab header also updates it. Set it to the same path as activeTab.',
  ),
});

// 025-ui-preview-a2ui-tools: make Card OPTIONALLY selectable — a clickable card
// that highlights its border when picked (e.g. subscription plan panels).
// `action` (usually a setData) fires when the whole card is clicked; `selected`
// (bindable boolean, usually a {call:"equals"} against the chosen value) drives
// the highlight. Backward compatible: a plain Card without them stays a static
// bordered block.
const CardSchema = CardApi.schema.extend({
  action: ActionSchema.optional().describe(
    'Optional: makes the WHOLE card clickable. Usually a setData action, e.g. {"event":{"name":"setData","context":{"target":"/plan","value":"pro"}}}.',
  ),
  selected: DynamicBooleanSchema.optional().describe(
    'Optional: when true the card shows a highlighted (selected) border. Bind it to reflect the current choice, e.g. {"call":"equals","args":{"a":{"path":"/plan"},"b":"pro"}}.',
  ),
});

export const CATALOG_DEFINITIONS = {
  Text: { props: TextApi.schema },
  Image: { props: ImageApi.schema },
  Icon: { props: IconApi.schema },
  Video: { props: VideoApi.schema },
  AudioPlayer: { props: AudioPlayerApi.schema },
  Row: { props: RowApi.schema },
  Column: { props: ColumnApi.schema },
  List: { props: ListApi.schema },
  Card: { props: CardSchema },
  Tabs: { props: TabsSchema },
  Modal: { props: ModalApi.schema },
  Divider: { props: DividerApi.schema },
  Button: { props: ButtonApi.schema },
  TextField: { props: TextFieldApi.schema },
  CheckBox: { props: CheckBoxApi.schema },
  ChoicePicker: { props: ChoicePickerApi.schema },
  Slider: { props: SliderApi.schema },
  DateTimeInput: { props: DateTimeInputApi.schema },
} satisfies CatalogDefinitions;

// Present on nearly every component; adds noise without adding value for a
// first-draft mockup, so it's omitted from the generated prompt reference.
const SKIP_FIELDS = new Set(["accessibility", "weight"]);

// Deliberately NOT importing zod's own types here: the top-level `zod`
// dependency resolves to v4 (pulled in by an unrelated AI SDK package), while
// `@a2ui/web_core` (and the schemas it exports) are built against a nested
// zod v3 — the two packages' types don't structurally overlap. Since we're
// reaching into `_def` internals anyway (not part of any officially exported
// type, in either version), a minimal local structural type sidesteps the
// version mismatch entirely rather than fighting it with casts.
interface AnySchema {
  description?: string;
}
interface ZodInternals {
  typeName: string;
  innerType?: AnySchema;
  values?: string[];
  type?: AnySchema;
  shape?: () => Record<string, AnySchema>;
  options?: AnySchema[];
}

function internals(t: AnySchema): ZodInternals {
  return (t as unknown as { _def: ZodInternals })._def;
}

function unwrap(t: AnySchema): AnySchema {
  const def = internals(t);
  if (def.typeName === "ZodOptional" || def.typeName === "ZodDefault" || def.typeName === "ZodNullable") {
    return unwrap(def.innerType!);
  }
  return t;
}

function isOptional(t: AnySchema): boolean {
  const typeName = internals(t).typeName;
  return typeName === "ZodOptional" || typeName === "ZodDefault";
}

// Some schema field descriptions carry an internal `REF:<file>#<pointer>|<human
// text>` marker (a leftover of the upstream JSON-schema-generation tooling).
// Keep only the human text after the `|`; drop the field's description
// entirely if it's a bare REF with nothing human after it (e.g. Button.action).
function cleanDescription(desc: string | undefined): string | undefined {
  if (!desc) return undefined;
  const m = /^REF:[^|]*\|(.*)$/.exec(desc);
  if (m) return m[1] || undefined;
  if (/^REF:/.test(desc)) return undefined;
  return desc;
}

function describeType(t: AnySchema, depth = 0): string {
  const u = unwrap(t);
  const def = internals(u);
  switch (def.typeName) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodEnum":
      return `enum[${def.values!.join("|")}]`;
    case "ZodArray":
      return depth > 0 ? "array" : `array<${describeType(def.type!, depth + 1)}>`;
    case "ZodObject": {
      if (depth > 1) return "object";
      const shape = def.shape!();
      const fields = Object.entries(shape)
        .filter(([k]) => !SKIP_FIELDS.has(k))
        .map(([k, v]) => `${k}${isOptional(v) ? "?" : ""}: ${describeType(v, depth + 1)}`);
      return `{${fields.join(", ")}}`;
    }
    case "ZodUnion":
      // Real-value unions in this schema are "plain value | {path} data-binding |
      // {call} function-binding" (see the A2UI v0.9 spec's DynamicString/
      // DynamicValue types) — describe the plain-value branch only; dynamic
      // bindings are an advanced feature mentioned once, generically, in the
      // prompt rather than per field.
      return describeType(def.options![0], depth);
    default:
      return "value";
  }
}

/** A compact, always-in-sync textual schema reference for every catalog
 *  component, for embedding in the A2UI generation prompt. Derives
 *  directly from the same zod schemas the renderer uses — never
 *  hand-duplicated, so it can't drift the way a hardcoded name-only list
 *  (or a hand-written schema copy) would. */
export function describeCatalogForPrompt(): string {
  const blocks: string[] = [];
  for (const [name, { props }] of Object.entries(CATALOG_DEFINITIONS)) {
    const shape = internals(props as AnySchema).shape!();
    const fields = Object.entries(shape)
      .filter(([k]) => !SKIP_FIELDS.has(k))
      .map(([k, v]) => {
        const desc = cleanDescription(v.description);
        return `  ${k}${isOptional(v) ? "?" : ""}: ${describeType(v)}${desc ? ` — ${desc}` : ""}`;
      });
    blocks.push(`${name}(\n${fields.join("\n")}\n)`);
  }
  return blocks.join("\n\n");
}
