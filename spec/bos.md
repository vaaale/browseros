We are going to write a single-page BrowserOS using nodejs and nextjs. The os must use server-side rendering.
We will use gitlab which is already configured (cloned).
Below is a description of the initial requirements of the Browser OS (BOS from here on):

# Basic functionality
The os must have a file browser and web browser.
It must be possible to change the wallpaper

# Agentic behavior and automation
The os must have a built-in chat to talk to the BOS agent.
The agent must support MCP servers
The chat must use copilotkit (https://www.copilotkit.ai/)

# Configuration
BOS must provide functionality that apps and features can use to hook into the configuration system.
For example, an app should be able to add a tab / page to the configuration app for the user to configure itself.
This should also be exposed as tools to the assistant automatically.

## Configuring models and providers
It must be possible to configure the AI providers such as OpenAI, OpenAI Codex, Anthropic and Local models as OpenAI Compatible.
It must be possible to configure the model, api keys, api base url.

# Assistant
BOS must support multiple profiles / personalities.
The "Assistant" app must have a way for the user to select which profile he wants to use.
The Assistant must be able to do basically anything in BOS. This includes building new apps or BOS features, configuring settings, opening apps, etc.
The assistant must always delegate tasks to a sub agent. If an appropriate sub-agent does not exist, the assistant must create one. See Sub agents below.
When the assistant is working, events such as reasoning / thinking, tool calls / tool responses, etc. must be shown in the UI. The events must be rendered using an appropriate card. The cards must be collapsible. When an event is received, the corresponding card should be shown expanded. After a certain amount of time or when a new event is received, the card should collapse so that only the heading of the event is visible in the UI. The heading should be derived from the type of event.
There should be some kind of indicator showing that the agent is working / busy. When the task is complete, the indicator should change so that the user understands that the assistant is done with the task.

## Memory system
The agent must have a self-improving memory system similar to Hermes-Agent.

## Skills
The assistant must have a library of skills. You can take a look at Hermes-Agent for inspiraction.
Any agent must be configurable using the Settings app.

## Profiles and personalities
The files making up an agents personality or profile must be stored in a directory structure of markdown files.

## Task delegation
The agent must delegate to a sub-agent whenever an appropriate sub-agent exists.

## Sub agents
Sub agents in BOS are defined as a set of markdown files located in a subdirectory of /agents. (In the data folder). The name of the foler is the agents name.
BOS must support creating a sub-agent dynamically. Such agents will only live for the duration of the task execution.
Sub-agents can be either a Local sub-agent, or a Claude sub-agent. Claude sub-agents must be used for any development task! This is important!
For any other task, the default must be to use a Local sub-agent.
If the assistant want to use a Claude Code agent for a none-coding task, it must ask the user for permission before doing so. An elisitation card should
show up if the assistants want's to ask this question with the choices: Allow Claude Agent once, Allow Claude Agent this session, Use Local.

## UI
Events such as tool calls / tool responses, reasoning, etc. must be shown in the UI. This also includes events from sub-agents. Such events must be shown in a nested structure. The nesting should happen on an agent level. For example something like this:
Assistant:
  |-Thinking
  |-Tool call - delegate_to: Researcher
  |-Researcher
  	|-Thinking
  	|-Tool call - web-search
  	|-Tool response
  	|- .......
  	|- .......
  	|-Responding
  |-Responding
(The example above is just for illustrating what is ment by "nesting". The point is that this will help the user understand what is going on)


### Right Sidepanel
The "Assistant" app must have a tabbed side panel:
- A tab showing the tools available to the current agent
- A tab showing the the skills that the agent has available
- A tab showing the MCP servers the agent has available, and the state of each MCP server. (Connected / Disconnected)

### Left Sidepanel
The left sidepanel is used for conversation management.
Start a new conversation, delete a conversation, or select and resume a conversation by clicking on it.

## Agent self improvement
The agent must be self improving similar to how Hermes-Agent does it.
Here are some key-points:
- Automatically create new skills from a conversation if found reasonable to do so.
- The assistant must perform self-reflection to evaluate how well it performed a task
- Use GEPA to improve any skill over time based on feedback from the user or self-reflection

## User interface
The chat must support streaming by default.
It must support receiving and rendering events like reasoning, tool calls / responses, etc.
It must support rendering in-line code blocks, markdown, html, etc.
It must support MCP Apps / MCP-UI

## Planner agent
The planner agent is responsible for creating a plan for how to solve a given task.
A plan consists of a set of tasks:
- Name
- Description
- Acceptance criteria

## Developer sub-agent
BOS must have an out-of-the-box Developer agent.
This agent MUST use the Claude Code MCP server for all its tasks.


# Extensibility
As with any real operating system, bos must provide api's for extending the os with new apps and functionality.
We will use this functionality to build applications from within the OS.
BOS must have a built-in development harness using Claude MCP. Claude MCP is running on http://wingman.akhbar.lan:7272/mcp using streamable-http transport.
When a new app is created, an appropriate icon should be associated with the app. The desktop should be refreshed so that the new icon appears.
If an app is removed, the icon must be removed from the desktop (Refreshed)

# BOS Self improvement
If the user asks the assistant to implement a new app or feature, BOS must evaluate if the implementation:
1) Will require making architectural changes for an optimal solution
2) Architectural changes should be made to better the quality of BOS

# Minimizing blas radius
Whenever changes are made to BOS, the changes MUST developed using a feature branch so that it can be rolle back if BOS breaks.
It's important that the agent adds new / stages files when during such work.

# Documentation
BOS must have a documentation hub containing user-friendly documentation for how to use BOS.
Whenever a new app of feature is created, added, modified, or removed, the documentation MUST be updated.

# Using the Claude MCP
When creating an agent, "agent_type" must be specified. The value of "agent_type" should reflect the type of agent begin created. For example: developer, tester, ui_expert, etc.

# On first startup
The first time the user opens BOS, a configuration wizzard should appear where the user can configure the AI models to use, as well as configure
the Claude Code MCP server.