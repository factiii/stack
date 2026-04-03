# Key Types

Source: `src/types/` (config.ts, plugin.ts, cli.ts)

## Core Enums
```typescript
type Stage = 'dev' | 'secrets' | 'staging' | 'prod';
type ServerOS = 'mac' | 'ubuntu' | 'windows' | 'amazon-linux' | 'alpine';
type Severity = 'critical' | 'warning' | 'info';
type ReachVia = 'local' | 'ssh' | 'workflow' | 'api' | 'github-api';
type PluginCategory = 'pipeline' | 'server' | 'framework' | 'addon';
type ProdSafetyLevel = 'safe' | 'caution' | 'destructive';
type CommandCategory = 'db' | 'ops' | 'backup';
```

## Reachability (discriminated union)
```typescript
type Reachability =
  | { reachable: true; via: ReachVia }
  | { reachable: false; reason: string };
```

## FactiiiConfig (stack.yml)
```typescript
interface FactiiiConfig {
  name: string;
  config_version?: string;
  github_repo?: string;
  ssl_email?: string;
  pipeline?: string;
  prisma_schema?: string | null;
  prisma_version?: string | null;
  trusted_plugins?: string[];
  container_exclusions?: string[];
  ansible?: { vault_path: string; vault_password_file?: string };
  dev_only?: boolean;
  env_match_exceptions?: string[];
  [environmentName: string]: any;  // dynamic environment keys
}
```

## EnvironmentConfig (top-level keys in stack.yml)
```typescript
interface EnvironmentConfig {
  server: ServerOSConfig;
  domain: string;
  ssh_user?: string;
  ssl_email?: string;
  env_file?: string;
  server_mode?: boolean;
  pipeline?: string;
  config?: 'ec2' | 'free-tier' | 'standard' | 'enterprise';
  access_key_id?: string;
  region?: string;
  plugins?: Record<string, Record<string, unknown>>;
}
```

## Plugin Interfaces
```
PluginStatic          — Base static (id, name, category, version, fixes, shouldLoad)
PipelinePluginStatic  — + canReach(), commands?, generateWorkflows?
ServerPluginStatic    — + os, packageManager, serviceManager
PipelinePluginInstance — deployStage(), scanStage(), fixStage()
ServerPluginInstance   — ensureServerReady()
```

## PluginCommand
```typescript
interface PluginCommand {
  name: string;
  description: string;
  category: CommandCategory;        // 'db' | 'ops' | 'backup'
  stages?: Stage[];
  prodSafety: ProdSafetyLevel;      // 'destructive' requires --force
  options?: CommandOption[];
  execute: (stage, options, config, rootDir) => Promise<CommandResult>;
}
```
