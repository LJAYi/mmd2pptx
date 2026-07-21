# Public example policy

Every diagram, document, screenshot, and test fixture committed to mmd2pptx
must be safe to publish permanently.

## Required

- Create public examples from scratch using fictional, generic concepts.
- Add the text `mmd2pptx synthetic fixture` to standalone fixture files and
  source files that contain the default demo.
- Keep only the minimum content needed to test the feature.
- Run `pnpm fixtures:check` before committing.
- Confirm that the contributor owns or may redistribute every included asset.

## Prohibited

- User-provided diagrams, prompts, attachments, or screenshots.
- Examples derived from private work, even after names or numbers are changed.
- Customer, research, medical, financial, operational, or unpublished project
  data.
- Credentials, access tokens, private URLs, real contact details, or public IP
  addresses.

Automated checks catch common credentials and identifiers but cannot determine
whether prose was copied from a private source. Reviewers must reject examples
whose provenance is uncertain.
