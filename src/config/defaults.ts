import type { Config } from '../contracts/config.ts';

export const defaults: Config = {
  schema_version: 1,
  agent: { backend: 'dsh', max_commands: 15, max_steps: 15, max_questions: 5, active_timeout_seconds: 600 },
  routing: { mode: 'auto', classifier: 'backend', confidence_threshold: 0.9, timeout_seconds: 12, on_ambiguous: 'ask' },
  ui: { mode: 'opentui', language: 'zh-CN', color: 'auto', output_preview_lines: 12 },
  approval: { mode: 'ask', default_selection: 'approve', editor_enter: 'execute' },
  execution: { executor: 'local-zsh', shell: '/bin/zsh', timeout_seconds: 30, max_output_bytes: 65536 },
  history: { enabled: true, default_scope: 'project', auto_gc: false, retention_days: 30, max_total_mb: 1024, store_command_output: true, include_classifier: false },
  backends: { dsh: { binary: 'dsh', model: 'deepseek-flash', api_key_env: 'DEEPSEEK_API_KEY', disabled: false } },
  context: { text: '' }, profiles: {},
};
