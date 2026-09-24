---
name: design-stress-test
description: Delegates to the devil-s-advocate agent for Socratic stress-testing of designs and plans.
created_by: seed
---

# Design Stress Test

## Purpose
Stress-test plans, designs, and ideas before they're locked in. Delegates to the devil-s-advocate agent for Socratic questioning.

## When to Use
- Before finalizing a plan or spec
- When an idea needs validation before implementation
- When the Build Studio agent wants to ensure robustness before moving forward

## Workflow

### Step 1: Assess Readiness
Determine if the design is ready for stress-testing:
- Is there enough detail to challenge?
- Are there clear assumptions to question?
- Is this the right time in the pipeline?

### Step 2: Delegate to devil-s-advocate
Use agent_delegate to invoke the stress-tester:

```
agent_delegate(
  agent: "devil-s-advocate",
  task: "Grill me on [specific design/plan] — context: [details]"
)
```

### Step 3: Incorporate Feedback
- Review the stress-test results
- Identify weak points or uncovered assumptions
- Update the design/spec accordingly
- Document decisions made during the session

## Output Format
After stress-testing, provide a summary:
- Assumptions challenged
- Weak points identified
- Recommendations for improvement
- Open questions that need resolution

## When NOT to Use
- When the design is too early-stage to be meaningful
- When time constraints don't allow for the session
- When the team has already committed to a direction
