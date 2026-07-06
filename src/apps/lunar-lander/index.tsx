"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GameCanvas } from "./components/GameCanvas";
import { HUD } from "./components/HUD";
import { GameOver } from "./components/GameOver";
import { Menu } from "./components/Menu";
import { useGameLoop } from "./hooks/useGameLoop";
import { useKeyboardInput } from "./hooks/useKeyboardInput";
import {
  createInitialSession,
  setDifficulty,
  startNewRound,
} from "./game/engine/GameState";
import type { GameSession } from "./game/engine/GameState";
import { tickGame } from "./game/engine/GameLoop";
import type { Difficulty } from "./game/utils/Constants";
import "./styles/game.css";

// Top-level component BrowserOS mounts when the Lunar Lander window opens.
// Owns the session state, drives the game loop, and swaps overlays based on
// phase. Physics and rendering are pure — this shell is the only stateful part.
export default function LunarLanderApp() {
  const [session, setSession] = useState<GameSession>(createInitialSession);

  // The `<div>` that owns focus for keyboard input. Attaching to the container
  // instead of window means arrow keys don't fight with other BOS windows.
  const rootRef = useRef<HTMLDivElement | null>(null);

  const handleRestart = useCallback(() => {
    setSession((prev) => {
      if (prev.phase !== "landed" && prev.phase !== "crashed") return prev;
      return startNewRound(prev);
    });
  }, []);

  const input = useKeyboardInput(handleRestart, rootRef);

  // Refocus on mount so arrow keys work immediately when the window opens.
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  // Advance the sim only while playing. When the phase flips to landed/crashed
  // the loop stops requesting frames, saving CPU.
  useGameLoop((dt) => {
    setSession((prev) => tickGame(prev, input, dt));
  }, session.phase === "playing");

  const handleStart = useCallback(() => {
    setSession((prev) => startNewRound(prev));
  }, []);

  const handleGoToMenu = useCallback(() => {
    setSession((prev) => ({ ...prev, phase: "menu" }));
  }, []);

  const handleDifficulty = useCallback((d: Difficulty) => {
    setSession((prev) => setDifficulty(prev, d));
  }, []);

  // If fuel runs out with the lander still airborne, we want the sim to keep
  // running under gravity — no special-case; stepPhysics already ignores the
  // thrust key when fuel is zero. Nothing to do here.

  const overlay = useMemo(() => {
    if (session.phase === "menu") {
      return (
        <Menu
          difficulty={session.difficulty}
          highScore={session.highScore}
          onStart={handleStart}
          onSelectDifficulty={handleDifficulty}
        />
      );
    }
    if (session.phase === "landed" || session.phase === "crashed") {
      return (
        <GameOver
          phase={session.phase}
          crashReason={session.crashReason}
          lastScore={session.lastScore}
          highScore={session.highScore}
          onRestart={handleRestart}
          onMenu={handleGoToMenu}
        />
      );
    }
    return null;
  }, [
    session.phase,
    session.difficulty,
    session.highScore,
    session.crashReason,
    session.lastScore,
    handleStart,
    handleDifficulty,
    handleRestart,
    handleGoToMenu,
  ]);

  return (
    <div
      ref={rootRef}
      className="ll-root"
      tabIndex={0}
      data-testid="lunar-lander-root"
    >
      <div className="ll-stage">
        <GameCanvas session={session} />
        {session.phase === "playing" && (
          <HUD lander={session.lander} highScore={session.highScore} score={session.score} />
        )}
        {overlay}
      </div>
    </div>
  );
}
