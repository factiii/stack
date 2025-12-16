# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned
- Expo plugin for mobile app builds
- Prisma/tRPC server plugin
- AWS Free Tier bundled plugin
- Next.js/Vercel plugin
- Next.js/Server plugin

---

## [1.0.0] - 2024-12-16

### Added
- Initial release of Core infrastructure package
- Plugin architecture with 4 categories: Secrets, Servers, Frameworks, Pipelines
- `npx core init` - Comprehensive scan with local auto-fix
- `npx core init fix` - Fix dev + GitHub issues
- `npx core deploy` - Direct SSH deployment
- GitHub Secrets plugin for credential storage
- Mac Mini server plugin
- AWS EC2 server plugin (partial)
- GitHub Actions pipeline (default)
- Auto-detection of Prisma configuration
- `coreAuto.yml` generation with OVERRIDE pattern
- `core.yml` template with EXAMPLE- prefix pattern
- Workflow generation for repos (staging, production, undeploy)
- Version tracking in coreAuto.yml

### Configuration
- Minimal secrets approach (only SSH keys and AWS_SECRET_ACCESS_KEY)
- Host, AWS access key ID, and region in core.yml (not secrets)
- SSH user defaults to ubuntu in coreAuto.yml

### Documentation
- README.md with quick start guide
- STANDARDS.md with full plugin architecture
- Universal interfaces specification
- Framework/Server compatibility matrix

---

## Version History

| Version | Date | Description |
|---------|------|-------------|
| 1.0.0 | 2024-12-16 | Initial release |

---

## Migration Guides

### Upgrading to 1.0.0

This is the initial release. No migration required.

### Future Migrations

When breaking changes occur, migration guides will be added here with:
- What changed
- How to update your core.yml
- How to update your coreAuto.yml
- Any manual steps required

