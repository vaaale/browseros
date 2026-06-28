# Documentation
The documentation in BOS play two roles:

## Documentation intended for the user
The user documentation is located under *docs/usage* and contains documentation inteneded for 'human consumption'. It describes how the core functionality of BOS such as having the ability to modify itself, develop apps etc. The documentation is devided into sub-sections, each placed in it's own directory tree:
(The structure below is just for illistration. The folders and filenames must match what's in BOS)
```text
usage
 |-introduction.md
 |-self-improvment
    |-learning-from-experience.md
    |-learning-from-memories.md
 |-memory
    |-how-memory-works.md
 |-apps
    |-assistant
       |-assistant.md
    |-settings
       |-settings.md
 |-.....
```
## Documentation intended for the developer agent
The development documentation is located under *docs/dev*. This documentation provides detailed documentation of how all the different sub-systems of BOS works and is intended to be used by agents such as Claude Code to help it extend or modify BOS or the applications in BOS. The documentation follows the same folder structure as the user documentation:
(The structure below is just for illistration. The folders and filenames must match what's in BOS)
```text
dev
 |-architecture-overview.md
 |-....
 |-apps
    |-api
       |-memory
          |-memory.md
       |-....
       |-....
    |-....
```