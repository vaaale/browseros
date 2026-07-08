import { NextRequest, NextResponse } from "next/server";
import { listConfigSchemas, getRegistration } from "@/lib/config/registry";
import type { ConfigField, ConfigSchemaView } from "@/lib/config/types";

export const dynamic = "force-dynamic";

function maskValues(fields: ConfigField[], raw: Record<string, unknown>) {
  const values: Record<string, unknown> = {};
  const secretsSet: Record<string, boolean> = {};
  for (const f of fields) {
    const v = raw[f.key];
    if (f.secret) {
      secretsSet[f.key] = !!v;
      values[f.key] = "";
    } else {
      values[f.key] = v ?? "";
    }
  }
  return { values, secretsSet };
}

function coerce(fields: ConfigField[], input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (!(f.key in input)) continue;
    const v = input[f.key];
    if (f.secret && (v === "" || v == null)) continue; // empty secret = keep existing
    if (f.type === "number") {
      const n = Number(v);
      if (!Number.isNaN(n) && v !== "") out[f.key] = n;
    } else if (f.type === "boolean") {
      out[f.key] = !!v;
    } else {
      out[f.key] = v;
    }
  }
  return out;
}

export async function GET() {
  const schemas: ConfigSchemaView[] = [];
  for (const schema of listConfigSchemas()) {
    const reg = getRegistration(schema.namespace)!;
    const raw = await reg.load();
    schemas.push({ ...schema, ...maskValues(schema.fields, raw) });
  }
  return NextResponse.json({ schemas });
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const namespace = String(body.namespace ?? "");
    const reg = getRegistration(namespace);
    if (!reg) return NextResponse.json({ error: `Unknown config namespace: ${namespace}` }, { status: 400 });
    const patch = coerce(reg.schema.fields, (body.values ?? {}) as Record<string, unknown>);
    await reg.save(patch);
    const raw = await reg.load();
    return NextResponse.json({ namespace, ...maskValues(reg.schema.fields, raw) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
