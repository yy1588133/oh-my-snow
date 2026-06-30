---
name: wiki
description: Automatically generate wiki documentation from source code analysis.
---

# OMS Wiki Generation Skill

This skill automatically generates comprehensive wiki-style documentation from source code analysis. Use this to create or update project documentation by analyzing the codebase structure, APIs, and architecture.

## When to Use

- A new project needs documentation from scratch
- Existing documentation is outdated and needs regeneration
- Onboarding new team members who need a codebase guide
- Before a major release to ensure documentation is complete
- After significant architectural changes

## Procedure

### Step 1: Analyze Project Structure

1. Read the project root directory with `filesystem-read`
2. Read package.json/go.mod/Cargo.toml to understand dependencies and scripts
3. Map the directory tree — identify source directories, test directories, config files
4. Identify the project type (library, app, CLI, service, monorepo)
5. Determine the tech stack and frameworks used

### Step 2: Document Architecture

1. **Overview** — Write a 2-3 paragraph project overview: what it does, why it exists, who uses it
2. **Architecture diagram** — Describe the high-level architecture in text (components, layers, data flow)
3. **Key design decisions** — Identify and document important architectural choices
4. **Directory structure** — Document each top-level directory and its purpose

Use `codebase-search` to find architectural patterns and key abstractions.

### Step 3: Document APIs

For each public API surface:

1. **REST/GraphQL endpoints** — Document each endpoint: method, path, request/response schema, auth requirements
2. **Public functions/classes** — Document exported APIs with signatures, parameters, return types, and examples
3. **Configuration** — Document all configuration options, environment variables, and defaults
4. **Events/hooks** — Document any events emitted or hooks supported

Use `ace-search` with `action: file_outline` to get the structure of key files.

### Step 4: Document Data Models

1. **Database schema** — Document tables, columns, relationships, and indexes
2. **Type definitions** — Document TypeScript interfaces/types, Go structs, Python dataclasses
3. **Serialization** — Document how objects are serialized/deserialized (JSON, protobuf, etc.)
4. **Validation** — Document validation rules and constraints

### Step 5: Document Workflows

1. **Setup** — Document how to install, configure, and run the project
2. **Development** — Document the development workflow (build, test, lint, debug)
3. **Deployment** — Document deployment steps and environment requirements
4. **Testing** — Document the testing strategy and how to run tests

### Step 6: Generate Wiki Pages

Create documentation files for each section:

```
docs/wiki/
  Home.md              — Project overview and table of contents
  Architecture.md      — Architecture and design decisions
  API-Reference.md     — Complete API documentation
  Data-Models.md       — Database schema and type definitions
  Getting-Started.md   — Installation and setup guide
  Development.md       — Development workflow and contributing guide
  Deployment.md        — Deployment instructions
  Testing.md           — Testing guide
```

Use `filesystem-create` to write each documentation file.

### Step 7: Cross-Reference and Link

1. Add internal links between related wiki pages
2. Add a table of contents to the Home page
3. Add cross-references where concepts are mentioned in multiple places
4. Ensure every documented API has a link to its source file

## Output Format

Each wiki page should follow this structure:

```markdown
# [Page Title]

## Overview
[Brief description of what this page covers]

## [Section 1]
[Content with examples]

## [Section 2]
[Content with code examples]

## See Also
- [Links to related pages]
```

## Rules

- Always verify documentation against actual code — never generate docs from assumptions
- Include runnable code examples where possible
- Keep documentation DRY — link to shared sections instead of duplicating
- Document both the happy path and error scenarios for APIs
- Include the generation date so users know when docs were last verified
- Use clear, simple language — avoid jargon when a plain explanation works
