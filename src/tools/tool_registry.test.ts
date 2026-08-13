import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from './tool_registry';

function definition(name: string) {
  return {
    type: 'function' as const,
    function: { name, description: `${name} tool`, parameters: { type: 'object' as const } },
  };
}

describe('ToolRegistry', () => {
  it('returns only selected, available tool definitions in registration order', () => {
    const registry = new ToolRegistry([
      { definition: definition('web_search'), category: 'search', isAvailable: () => true, execute: vi.fn() },
      { definition: definition('hidden'), category: 'utility', isAvailable: () => false, execute: vi.fn() },
      { definition: definition('wikipedia_lookup'), category: 'knowledge', isAvailable: () => true, execute: vi.fn() },
    ]);
    expect(registry.getDefinitions(['wikipedia_lookup', 'hidden']).map(tool => tool.function.name))
      .toEqual(['wikipedia_lookup']);
  });

  it('executes registered tools and handles unavailable names', async () => {
    const execute = vi.fn().mockResolvedValue({ role: 'tool', tool_call_id: '1', content: 'ok' });
    const registry = new ToolRegistry([
      { definition: definition('web_search'), category: 'search', isAvailable: () => true, execute },
    ]);
    const call = { id: '1', type: 'function' as const, function: { name: 'web_search', arguments: '{}' } };
    expect((await registry.execute(call)).content).toBe('ok');
    expect((await registry.execute({ ...call, function: { name: 'missing', arguments: '{}' } })).content)
      .toContain('unavailable');
  });
});
