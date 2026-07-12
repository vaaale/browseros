"use client";

import React, { useId, useState } from "react";
import { createCatalog, type CatalogRenderers } from "@copilotkit/a2ui-renderer";
import { BASIC_CATALOG_ID } from "@ag-ui/a2ui-toolkit";
import { CATALOG_DEFINITIONS } from "./catalog-schema";

// BOS-styled A2UI v0.9 catalog (013-build-studio-agentic V2). `@copilotkit/a2ui-renderer`'s
// default `basicCatalog` is an unstyled reference implementation (white cards, 1px gray
// borders, inline styles) meant as a protocol demo, not a themed component kit — rendered
// on BOS's dark UI Preview surface it looks broken. This reskins the SAME 18 component
// names/schemas (reusing their exact `*Api` prop schemas) with BOS's dark Tailwind look,
// since the server-side generation prompt (`a2ui-render.ts`) is hardcoded to only ever
// emit these names.
//
// catalogId MUST equal BASIC_CATALOG_ID: `assembleOps()` in a2ui-render.ts always stamps
// `createSurface` operations with that id, and `MessageProcessor` rejects a surface whose
// catalogId doesn't match a registered catalog's `.id` (see @a2ui/web_core's
// message-processor.js `processCreateSurfaceMessage`) — a mismatch here would make every
// real render throw "Catalog not found" instead of just looking unstyled.

/** The real `buildChild` supports a second `basePath` arg for data-bound repeated
 *  children (see a2ui-react/adapter.d.mts), but `RendererProps.children`'s public type
 *  only declares the single-arg form — widen it back for the repeated-list case. */
type BuildChild = (id: string, basePath?: string) => React.ReactNode;

/** Mirrors `@copilotkit/a2ui-renderer`'s internal ChildList: a resolved child-list prop is
 *  always a flat array of either plain string ids or `{id, basePath}` refs by render time
 *  (the generic binder materializes templated/data-bound lists into this shape). */
function renderChildRefs(list: unknown, buildChild: (id: string) => React.ReactNode): React.ReactNode {
  if (!Array.isArray(list)) return null;
  const build = buildChild as BuildChild;
  return list.map((item, i) => {
    if (item && typeof item === "object" && "id" in item) {
      const ref = item as { id: string; basePath?: string };
      return <React.Fragment key={`${ref.id}-${i}`}>{build(ref.id, ref.basePath)}</React.Fragment>;
    }
    if (typeof item === "string") return <React.Fragment key={`${item}-${i}`}>{build(item)}</React.Fragment>;
    return null;
  });
}

function mapJustify(j?: string): React.CSSProperties["justifyContent"] {
  switch (j) {
    case "center":
      return "center";
    case "end":
      return "flex-end";
    case "spaceAround":
      return "space-around";
    case "spaceBetween":
      return "space-between";
    case "spaceEvenly":
      return "space-evenly";
    case "start":
      return "flex-start";
    case "stretch":
      return "stretch";
    default:
      return "flex-start";
  }
}

function mapAlign(a?: string): React.CSSProperties["alignItems"] {
  switch (a) {
    case "start":
      return "flex-start";
    case "center":
      return "center";
    case "end":
      return "flex-end";
    case "stretch":
      return "stretch";
    default:
      return "stretch";
  }
}

// The `*Api.schema` zod types describe the PRE-binding declarative shape (a
// value can be a literal, a `{path}` data reference, or a `{call,...}`
// expression — see the generated `z.infer` unions from a failed first
// `tsc` pass). `RendererProps.children`'s generic binder resolves all of
// that down to plain values (and synthesizes `setValue`/`validationErrors`
// callbacks that aren't in the schema at all) before a renderer ever runs —
// which is what the reference basicCatalog's untyped `.mjs` components rely
// on. These interfaces describe that resolved shape instead, so renderers
// below cast into them rather than trusting the schema-inferred prop type.
interface ResolvedTextProps {
  text?: string;
  variant?: "h1" | "h2" | "h3" | "h4" | "h5" | "caption" | string;
}
interface ResolvedImageProps {
  url?: string;
  description?: string;
  fit?: "scaleDown" | string;
  variant?: "icon" | "avatar" | "smallFeature" | "largeFeature" | "header" | string;
}
interface ResolvedIconProps {
  name?: string | { path?: string };
}
interface ResolvedVideoProps {
  url?: string;
}
interface ResolvedAudioPlayerProps {
  url?: string;
  description?: string;
}
interface ResolvedContainerProps {
  children?: unknown;
  justify?: string;
  align?: string;
}
interface ResolvedListProps extends ResolvedContainerProps {
  direction?: "horizontal" | string;
}
interface ResolvedCardProps {
  child?: string;
}
interface ResolvedTabsProps {
  tabs?: { title?: string; child: string }[];
}
interface ResolvedModalProps {
  trigger?: string;
  content?: string;
}
interface ResolvedDividerProps {
  axis?: "vertical" | string;
}
interface ResolvedButtonProps {
  action?: () => void;
  child?: string;
  variant?: "primary" | "borderless" | string;
  isValid?: boolean;
}
interface ResolvedTextFieldProps {
  label?: string;
  value?: string;
  setValue: (v: string) => void;
  variant?: "longText" | "number" | "obscured" | string;
  validationErrors?: string[];
}
interface ResolvedCheckBoxProps {
  value?: boolean;
  setValue: (v: boolean) => void;
  label?: string;
  validationErrors?: string[];
}
interface ResolvedChoicePickerProps {
  value?: unknown[];
  setValue: (v: unknown[]) => void;
  options?: { value: unknown; label?: string }[];
  variant?: "mutuallyExclusive" | string;
  displayStyle?: "chips" | string;
  filterable?: boolean;
  label?: string;
}
interface ResolvedSliderProps {
  value?: number;
  setValue: (v: number) => void;
  min?: number;
  max?: number;
  label?: string;
}
interface ResolvedDateTimeInputProps {
  value?: string;
  setValue: (v: string) => void;
  enableDate?: boolean;
  enableTime?: boolean;
  label?: string;
  min?: string;
  max?: string;
}

const renderers: CatalogRenderers<typeof CATALOG_DEFINITIONS> = {
  Text: ({ props }) => {
    const p = props as unknown as ResolvedTextProps;
    const text = p.text ?? "";
    switch (p.variant) {
      case "h1":
        return <h1 className="text-2xl font-semibold text-white">{text}</h1>;
      case "h2":
        return <h2 className="text-xl font-semibold text-white">{text}</h2>;
      case "h3":
        return <h3 className="text-lg font-semibold text-white">{text}</h3>;
      case "h4":
        return <h4 className="text-base font-semibold text-white/90">{text}</h4>;
      case "h5":
        return <h5 className="text-sm font-semibold text-white/90">{text}</h5>;
      case "caption":
        return <small className="text-xs text-white/40">{text}</small>;
      default:
        return <span className="text-sm text-white/80">{text}</span>;
    }
  },

  Image: ({ props }) => {
    const p = props as unknown as ResolvedImageProps;
    const fit = p.fit === "scaleDown" ? "scale-down" : (p.fit ?? "fill");
    const variantClass =
      p.variant === "icon"
        ? "h-6 w-6 rounded"
        : p.variant === "avatar"
          ? "h-10 w-10 rounded-full"
          : p.variant === "smallFeature"
            ? "max-w-[100px]"
            : p.variant === "largeFeature"
              ? "max-h-[400px]"
              : p.variant === "header"
                ? "h-[200px] w-full"
                : "w-full";
    return (
      <img
        src={p.url}
        alt={p.description || ""}
        className={`block max-w-full rounded-md border border-white/10 bg-white/5 ${variantClass}`}
        style={{ objectFit: p.variant === "header" ? "cover" : (fit as React.CSSProperties["objectFit"]) }}
      />
    );
  },

  Icon: ({ props }) => {
    const p = props as unknown as ResolvedIconProps;
    const name = typeof p.name === "string" ? p.name : p.name?.path;
    return (
      <span
        className="material-symbols-outlined inline-flex h-6 w-6 items-center justify-center rounded bg-white/5 text-[10px] uppercase tracking-wide text-white/50"
        title={name}
      >
        {name}
      </span>
    );
  },

  Video: ({ props }) => {
    const p = props as unknown as ResolvedVideoProps;
    return <video src={p.url} controls className="w-full rounded-md border border-white/10 bg-black" style={{ aspectRatio: "16/9" }} />;
  },

  AudioPlayer: ({ props }) => {
    const p = props as unknown as ResolvedAudioPlayerProps;
    return (
      <div className="flex w-full flex-col gap-1">
        {p.description && <span className="text-xs text-white/50">{p.description}</span>}
        <audio src={p.url} controls className="w-full" />
      </div>
    );
  },

  Row: ({ props, children }) => {
    const p = props as unknown as ResolvedContainerProps;
    return (
      <div className="flex w-full flex-row gap-2" style={{ justifyContent: mapJustify(p.justify), alignItems: mapAlign(p.align) }}>
        {renderChildRefs(p.children, children)}
      </div>
    );
  },

  Column: ({ props, children }) => {
    const p = props as unknown as ResolvedContainerProps;
    return (
      <div className="flex w-full flex-col gap-2" style={{ justifyContent: mapJustify(p.justify), alignItems: mapAlign(p.align) }}>
        {renderChildRefs(p.children, children)}
      </div>
    );
  },

  List: ({ props, children }) => {
    const p = props as unknown as ResolvedListProps;
    const horizontal = p.direction === "horizontal";
    return (
      <div className={`flex w-full gap-2 ${horizontal ? "flex-row overflow-x-auto" : "flex-col overflow-y-auto"}`} style={{ alignItems: mapAlign(p.align) }}>
        {renderChildRefs(p.children, children)}
      </div>
    );
  },

  Card: ({ props, children }) => {
    const p = props as unknown as ResolvedCardProps;
    return (
      <div className="w-full rounded-lg border border-white/15 bg-white/[0.06] p-4 shadow-sm shadow-black/20">{p.child ? children(p.child) : null}</div>
    );
  },

  Tabs: ({ props, children }) => {
    const p = props as unknown as ResolvedTabsProps;
    const [selectedIndex, setSelectedIndex] = useState(0);
    const tabs = p.tabs ?? [];
    const active = tabs[selectedIndex];
    return (
      <div className="flex w-full flex-col">
        <div className="mb-2 flex gap-1 border-b border-white/10">
          {tabs.map((tab, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setSelectedIndex(i)}
              className={`border-b-2 px-3 py-1.5 text-xs font-medium transition-colors ${
                selectedIndex === i ? "border-violet-400 text-violet-200" : "border-transparent text-white/50 hover:text-white/80"
              }`}
            >
              {tab.title}
            </button>
          ))}
        </div>
        <div className="flex-1">{active ? children(active.child) : null}</div>
      </div>
    );
  },

  Modal: ({ props, children }) => {
    const p = props as unknown as ResolvedModalProps;
    const [isOpen, setIsOpen] = useState(false);
    return (
      <>
        <div onClick={() => setIsOpen(true)} className="inline-block cursor-pointer">
          {p.trigger ? children(p.trigger) : null}
        </div>
        {isOpen && (
          <div onClick={() => setIsOpen(false)} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
            <div
              onClick={(e) => e.stopPropagation()}
              className="flex max-h-[90%] max-w-[90%] flex-col overflow-auto rounded-lg border border-white/10 bg-neutral-900 p-6 shadow-xl"
            >
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="rounded p-1 text-lg leading-none text-white/50 hover:bg-white/10 hover:text-white"
                >
                  ×
                </button>
              </div>
              <div className="flex-1">{p.content ? children(p.content) : null}</div>
            </div>
          </div>
        )}
      </>
    );
  },

  Divider: ({ props }) => {
    const p = props as unknown as ResolvedDividerProps;
    return p.axis === "vertical" ? <div className="mx-2 w-px self-stretch bg-white/10" /> : <div className="my-2 h-px w-full bg-white/10" />;
  },

  Button: ({ props, children }) => {
    const p = props as unknown as ResolvedButtonProps;
    const variantClass =
      p.variant === "primary"
        ? "bg-violet-500/80 text-white hover:bg-violet-500"
        : p.variant === "borderless"
          ? "bg-transparent text-white/70 hover:bg-white/10 hover:text-white"
          : "border border-white/10 bg-white/5 text-white/90 hover:bg-white/10";
    return (
      <button
        type="button"
        onClick={p.action}
        disabled={p.isValid === false}
        className={`inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${variantClass}`}
      >
        {p.child ? children(p.child) : null}
      </button>
    );
  },

  TextField: ({ props }) => {
    const p = props as unknown as ResolvedTextFieldProps;
    const id = useId();
    const isLong = p.variant === "longText";
    const type = p.variant === "number" ? "number" : p.variant === "obscured" ? "password" : "text";
    const hasError = !!p.validationErrors?.length;
    const fieldClass = `w-full rounded-md border ${hasError ? "border-red-500/60" : "border-white/10"} bg-white/5 px-2.5 py-1.5 text-sm text-white/90 outline-none placeholder:text-white/30 focus:border-violet-400/50`;
    return (
      <div className="flex w-full flex-col gap-1">
        {p.label && (
          <label htmlFor={id} className="text-xs font-medium text-white/60">
            {p.label}
          </label>
        )}
        {isLong ? (
          <textarea id={id} className={fieldClass} value={p.value || ""} onChange={(e) => p.setValue(e.target.value)} />
        ) : (
          <input id={id} type={type} className={fieldClass} value={p.value || ""} onChange={(e) => p.setValue(e.target.value)} />
        )}
        {hasError && <span className="text-xs text-red-400">{p.validationErrors?.[0]}</span>}
      </div>
    );
  },

  CheckBox: ({ props }) => {
    const p = props as unknown as ResolvedCheckBoxProps;
    const id = useId();
    const hasError = !!p.validationErrors?.length;
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <input
            id={id}
            type="checkbox"
            checked={!!p.value}
            onChange={(e) => p.setValue(e.target.checked)}
            className={`h-4 w-4 cursor-pointer accent-violet-500 ${hasError ? "outline outline-1 outline-red-500" : ""}`}
          />
          {p.label && (
            <label htmlFor={id} className={`cursor-pointer text-sm ${hasError ? "text-red-400" : "text-white/80"}`}>
              {p.label}
            </label>
          )}
        </div>
        {hasError && <span className="text-xs text-red-400">{p.validationErrors?.[0]}</span>}
      </div>
    );
  },

  ChoicePicker: ({ props }) => {
    const p = props as unknown as ResolvedChoicePickerProps;
    const groupId = useId();
    const [filter, setFilter] = useState("");
    const values = Array.isArray(p.value) ? p.value : [];
    const exclusive = p.variant === "mutuallyExclusive";
    const onToggle = (val: unknown) => {
      if (exclusive) p.setValue([val]);
      else p.setValue(values.includes(val) ? values.filter((v) => v !== val) : [...values, val]);
    };
    const options = (p.options ?? []).filter(
      (opt) => !p.filterable || filter === "" || String(opt.label).toLowerCase().includes(filter.toLowerCase()),
    );
    const chips = p.displayStyle === "chips";
    return (
      <div className="flex w-full flex-col gap-2">
        {p.label && <span className="text-xs font-medium text-white/60">{p.label}</span>}
        {p.filterable && (
          <input
            type="text"
            placeholder="Filter options…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-sm text-white/90 outline-none placeholder:text-white/30 focus:border-violet-400/50"
          />
        )}
        <div className={`flex gap-2 ${chips ? "flex-row flex-wrap" : "flex-col"}`}>
          {options.map((opt, i) => {
            const selected = values.includes(opt.value);
            if (chips) {
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => onToggle(opt.value)}
                  className={`rounded-full px-3 py-1 text-xs transition-colors ${
                    selected ? "bg-violet-500/80 text-white" : "border border-white/10 bg-white/5 text-white/70 hover:bg-white/10"
                  }`}
                >
                  {opt.label}
                </button>
              );
            }
            return (
              <label key={i} className="flex cursor-pointer items-center gap-2 text-sm text-white/80">
                <input
                  type={exclusive ? "radio" : "checkbox"}
                  name={exclusive ? groupId : undefined}
                  checked={selected}
                  onChange={() => onToggle(opt.value)}
                  className="accent-violet-500"
                />
                {opt.label}
              </label>
            );
          })}
        </div>
      </div>
    );
  },

  Slider: ({ props }) => {
    const p = props as unknown as ResolvedSliderProps;
    const id = useId();
    return (
      <div className="flex w-full flex-col gap-1">
        <div className="flex items-center justify-between">
          {p.label && (
            <label htmlFor={id} className="text-xs font-medium text-white/60">
              {p.label}
            </label>
          )}
          <span className="text-xs text-white/40">{p.value}</span>
        </div>
        <input
          id={id}
          type="range"
          min={p.min ?? 0}
          max={p.max}
          value={p.value ?? 0}
          onChange={(e) => p.setValue(Number(e.target.value))}
          className="w-full cursor-pointer accent-violet-500"
        />
      </div>
    );
  },

  DateTimeInput: ({ props }) => {
    const p = props as unknown as ResolvedDateTimeInputProps;
    const id = useId();
    let type: "date" | "time" | "datetime-local" = "datetime-local";
    if (p.enableDate && !p.enableTime) type = "date";
    if (!p.enableDate && p.enableTime) type = "time";
    return (
      <div className="flex w-full flex-col gap-1">
        {p.label && (
          <label htmlFor={id} className="text-xs font-medium text-white/60">
            {p.label}
          </label>
        )}
        <input
          id={id}
          type={type}
          value={p.value || ""}
          onChange={(e) => p.setValue(e.target.value)}
          min={typeof p.min === "string" ? p.min : undefined}
          max={typeof p.max === "string" ? p.max : undefined}
          className="w-full rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-sm text-white/90 outline-none focus:border-violet-400/50 [color-scheme:dark]"
        />
      </div>
    );
  },
};

/** BOS's dark-themed A2UI v0.9 catalog — pass to `<A2UIProvider catalog={bosA2UICatalog}>`. */
export const bosA2UICatalog = createCatalog(CATALOG_DEFINITIONS, renderers, { catalogId: BASIC_CATALOG_ID });
