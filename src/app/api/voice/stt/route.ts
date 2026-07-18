import { NextRequest, NextResponse } from "next/server";
import { loadVoiceConfig } from "@/lib/voice/config";
import { transcribeAudio } from "@/lib/voice/stt-client";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const audioFile = form.get("audio");
    if (!audioFile || !(audioFile instanceof Blob)) {
      return NextResponse.json({ error: "Missing audio field" }, { status: 400 });
    }

    const cfg = await loadVoiceConfig();
    const buffer = Buffer.from(await audioFile.arrayBuffer());
    const mimeType = audioFile.type || "audio/webm";

    const result = await transcribeAudio(buffer, mimeType, cfg);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
