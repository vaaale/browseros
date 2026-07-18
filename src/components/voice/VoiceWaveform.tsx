"use client";

import { useEffect, useRef } from "react";

interface VoiceWaveformProps {
  stream: MediaStream | null;
  active: boolean;
  width?: number;
  height?: number;
  className?: string;
}

export function VoiceWaveform({ stream, active, width = 60, height = 24, className }: VoiceWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (!active || !stream) {
      ctx.clearRect(0, 0, width, height);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (ctxRef.current) void ctxRef.current.close().catch(() => {});
      ctxRef.current = null;
      analyserRef.current = null;
      return;
    }

    const audioCtx = new AudioContext();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);
    ctxRef.current = audioCtx;
    analyserRef.current = analyser;

    const data = new Uint8Array(analyser.fftSize);

    const draw = () => {
      rafRef.current = requestAnimationFrame(draw);
      analyser.getByteTimeDomainData(data);

      ctx.clearRect(0, 0, width, height);
      ctx.beginPath();
      ctx.strokeStyle = "#5b8cff";
      ctx.lineWidth = 1.5;

      const sliceWidth = width / data.length;
      let x = 0;
      for (let i = 0; i < data.length; i++) {
        const v = data[i]! / 128;
        const y = (v * height) / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
      }
      ctx.lineTo(width, height / 2);
      ctx.stroke();
    };

    draw();

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      void audioCtx.close().catch(() => {});
    };
  }, [active, stream, width, height]);

  return <canvas ref={canvasRef} width={width} height={height} className={className} />;
}
