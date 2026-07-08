# Lunar Lander

A tiny, self-contained descent game bundled with BrowserOS. Launched from the
Dock like any other built-in app; there's no configuration and no network calls
during play.

## Objective

Guide the lander from the top of the sky down to the green pad without
crashing:

- Touch down **inside** the pad's horizontal footprint.
- Vertical velocity at contact must be **≤ 20 units/s**.
- Landing angle must be **within ±15°** of upright.

Any other kind of touchdown counts as a crash.

## Controls

Keyboard only, active whenever the Lunar Lander window has focus.

| Key(s)                | Action                          |
| --------------------- | ------------------------------- |
| `↑` / `W`             | Main thrust (burns fuel)        |
| `←` `→` / `A` `D`     | Rotate left / right             |
| `Enter` / `R`         | Restart after landing or crash  |

Clicking the game window is enough to give it focus.

## HUD

The panel in the top-left displays live telemetry, updated every animation
frame:

- **ALT** — Altitude above the ground.
- **VY** — Vertical velocity (turns red once above the crash threshold).
- **VX** — Horizontal velocity.
- **FUEL** — Remaining fuel percentage. Thrust is disabled when this hits 0.
- **SCORE** — Current-round score (set on landing).
- **HI** — Best score across all rounds (persisted per browser via
  `localStorage`).

## Difficulty

From the main menu:

- **Easy** — wider pad, weaker gravity, more fuel.
- **Normal** — the classic tuning.
- **Hard** — narrower pad, stronger gravity, less fuel.

The chosen difficulty is remembered between sessions.

## Scoring

A successful landing awards points from four buckets:

- **Base** — a flat bonus just for touching down safely.
- **Fuel bonus** — proportional to fuel remaining.
- **Precision bonus** — larger the closer the touchdown is to the pad's
  centreline.
- **Softness bonus** — larger the further you were from the max landing
  velocity when you touched.

Crashes score 0.

## Where the code lives

The app is a native BrowserOS built-in under `src/apps/lunar-lander/`. It uses
BrowserOS's own React 19 + TypeScript build (no separate bundler) and is
auto-discovered by `tools/gen-apps.mjs`. Key modules:

```
src/apps/lunar-lander/
├── manifest.ts               # AppManifest (BOS registry)
├── index.tsx                 # React entry point + session state machine
├── components/               # HUD, GameCanvas, GameOver, Menu
├── hooks/                    # useGameLoop, useKeyboardInput
├── game/
│   ├── engine/               # Physics, GameState, GameLoop
│   ├── entities/             # Lander, LandingPad, Terrain
│   ├── systems/              # Collision, Score, Render, Input
│   └── utils/                # Vector2, Constants (tunables)
└── styles/game.css
```

Tunables (gravity, thrust power, fuel burn rate, scoring weights, difficulty
modifiers) all live in `game/utils/Constants.ts` — start there if you want to
rebalance the game.
