# Infinite Canvas Documentation Index

## Overview

- [Quick Start](/docs/overview/quick-start)
- [Features](/docs/overview/features)
- [Deploy on Render](/docs/overview/render)
- [Docker Deployment](/docs/overview/docker)
- [Third-party Prompt Sources](/docs/overview/third-party-prompt-repositories)

## Canvas Guide

- [Canvas Node Guide](/docs/canvas/canvas-node-manual)
- [Canvas Shortcuts](/docs/canvas/canvas-shortcuts)

## Development and Data

- [Local Development](/docs/development/local-development)
- [Agent Development Workflow](./matt-pocock-skills.md)
- [Canvas Data Structure](/docs/development/canvas-data-structure)
- [How the Local Codex Connection Works](/docs/development/local-codex-canvas)
- [Domain Context](../CONTEXT.md)
- [Platform PRD](./product/platform-prd.md)
- [Backend Platform Architecture](./architecture/backend-platform.md)
- [Backend Platform Roadmap](./architecture/platform-roadmap.md)
- [Requirements Traceability](./architecture/requirements-traceability.md)
- [Native Canvas Recovery Contract](./architecture/native-canvas-recovery.md)
- [Asset Lifecycle Contract](./architecture/assets.md)
- [Credit Ledger Contract](./architecture/credits-ledger.md)
- [AI Task and Provider Contract](./architecture/ai-task-provider.md)
- [Architecture Decision Records](./adr/README.md)

## Business

- [Open-source License](/docs/business/license)
- [Business Cooperation](/docs/business/business)

## Support and Security

- [Report a Vulnerability](/docs/support/security)
- [Sponsor the Project](/docs/support/sponsor)

## Project Progress

- [Changelog](/docs/progress/changelog)
- [Gate 0 Backend Verification](/docs/progress/gate-0-backend-verification)
- [Gate 0 Frontend Verification](/docs/progress/gate-0-frontend-verification)
- [Pending Tests](/docs/progress/pending-test)
- [TODO](/docs/progress/todo)

## Notes

- Authenticated Canvas snapshots and revisions are server-authoritative. Native IndexedDB stores only local recovery drafts and UI state; media bytes and My Assets remain browser-local until the Asset cutover.
- The AI API key is stored in the browser, which sends requests directly to OpenAI-compatible endpoints.
