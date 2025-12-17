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
- Initial release of Factiii Stack infrastructure package
- Plugin architecture with 4 categories: Secrets, Servers, Frameworks, Pipelines
- `npx factiii init` - Comprehensive scan with local auto-fix
- `npx factiii init fix` - Fix dev + GitHub issues
- `npx factiii deploy` - Direct SSH deployment
- GitHub Secrets plugin for credential storage
- Mac Mini server plugin
- AWS EC2 server plugin (partial)
- GitHub Actions pipeline (default)
- Auto-detection of Prisma configuration
- `factiiiAuto.yml` generation with OVERRIDE pattern
- `factiii.yml` template with EXAMPLE- prefix pattern
- Workflow generation for repos (staging, production, undeploy)
- Version tracking in factiiiAuto.yml

### Configuration
- Minimal secrets approach (only SSH keys and AWS_SECRET_ACCESS_KEY)
- Host, AWS access key ID, and region in factiii.yml (not secrets)
- SSH user defaults to ubuntu in factiiiAuto.yml

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
- How to update your factiii.yml
- How to update your factiiiAuto.yml
- Any manual steps required



