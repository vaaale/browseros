Phase 6 — Testing.

Test files must be named e2e/<feature-id>.spec.ts (e.g. e2e/001-my-feature.spec.ts) so buildstudio_run_tests can locate them by convention.

Steps:
1. Call dev_delegate to write the tests:
     "Write Playwright e2e tests for <feature-name>.
      Test file: e2e/<feature-id>.spec.ts.
      Tests must cover: <acceptance criteria from spec.md>.
      Use the existing playwright.config.ts (reuseExistingServer: true, baseURL: http://localhost:3000).
      Tests should be focused and deterministic — avoid timing-dependent assertions."
2. After the Developer confirms the test file exists, call:
     buildstudio_run_tests(featurePath='user-specs/<id>')
   This runs Playwright, writes test-results.md to the spec folder, and updates the Test phase badge in the PhaseStrip:
     - Green (done) = all tests passed
     - Amber (pending) = tests ran but one or more failed
3. If tests fail: read the output summary, identify which assertions failed, delegate a targeted fix to the Developer, then call buildstudio_run_tests again.
4. Repeat until all tests pass (Test badge is green).

Only proceed to Phase 7 (Promote / Discard) after all tests pass.
