import { createRequire } from 'node:module';
// Execute the production Lua, rather than duplicating its state machine in mocks.
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = createRequire(import.meta.url)('fengari');

export class LuaRedis {
  values = new Map<string, string>();
  sorted = new Map<string, Map<string, number>>();
  expires = new Map<string, number>();
  now = 1_000_000;
  hashes = new Map<string, Record<string, number>>();

  async get(key: string): Promise<string | null> { return (this.command(['GET', key]) || null) as string | null; }
  async set(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async zadd(key: string, score: number, member: string): Promise<void> { this.command(['ZADD', key, score, member]); }
  async zrem(key: string, member: string): Promise<boolean> { return Number(this.command(['ZREM', key, member])) > 0; }
  async zrangeAll(key: string): Promise<string[]> { return this.entries(key).map(([member]) => member); }
  async zrangeByScore(key: string, min: number, max: number, limit = 50): Promise<string[]> {
    return this.entries(key).filter(([, score]) => score >= min && score <= max).slice(0, limit).map(([member]) => member);
  }
  async withLock<T>(_key: string, fn: () => Promise<T>): Promise<T> { return fn(); }
  private entries(key: string): [string, number][] {
    return [...(this.sorted.get(key) ?? new Map())].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  }
  private command(args: (string | number)[]): unknown {
    const [op, rawKey, ...rest] = args;
    const key = String(rawKey);
    if ((this.expires.get(key) ?? Infinity) <= this.now) { this.values.delete(key); this.expires.delete(key); }
    switch (op) {
      case 'GET': return this.values.get(key) ?? false;
      case 'EXISTS': return this.values.has(key) ? 1 : 0;
      case 'SET': {
        if (rest.includes('NX') && this.values.has(key)) return null;
        this.values.set(key, String(rest[0]));
        this.expires.delete(key);
        if (rest[1] === 'PX') this.expires.set(key, this.now + Number(rest[2]));
        if (rest[1] === 'EX') this.expires.set(key, this.now + Number(rest[2]) * 1000);
        return 'OK';
      }
      case 'DEL': return this.values.delete(key) ? 1 : 0;
      case 'HINCRBY': {
        const hash = this.hashes.get(key) ?? {};
        hash[String(rest[0])] = (hash[String(rest[0])] ?? 0) + Number(rest[1]);
        this.hashes.set(key, hash); return hash[String(rest[0])];
      }
      case 'HGETALL': return Object.entries(this.hashes.get(key) ?? {}).flatMap(([k, v]) => [k, String(v)]);
      case 'INCR': { const value = Number(this.values.get(key) ?? 0) + 1; this.values.set(key, String(value)); return value; }
      case 'EXPIRE': this.expires.set(key, this.now + Number(rest[0]) * 1000); return 1;
      case 'ZSCORE': return this.sorted.get(key)?.get(String(rest[0])) ?? false;
      case 'ZADD': {
        const entries = this.sorted.get(key) ?? new Map<string, number>();
        entries.set(String(rest[1]), Number(rest[0])); this.sorted.set(key, entries); return 1;
      }
      case 'ZREM': return this.sorted.get(key)?.delete(String(rest[0])) ? 1 : 0;
      case 'ZRANGE': return this.entries(key).slice(Number(rest[0]), Number(rest[1]) + 1).map(([member]) => member);
      case 'ZRANGEBYSCORE': return this.entries(key).filter(([, score]) => score >= Number(rest[0]) && score <= Number(rest[1]))
        .slice(Number(rest[3] ?? 0), Number(rest[3] ?? 0) + Number(rest[4] ?? 50)).map(([member]) => member);
      default: throw new Error(`Unsupported test Redis command: ${op}`);
    }
  }

  async execute(args: (string | number)[]): Promise<unknown> {
    if (args[0] === 'EVAL') return this.eval(String(args[1]), args.slice(3, 3 + Number(args[2])).map(String), args.slice(3 + Number(args[2])));
    const value = this.command(args);
    return value === false ? null : value;
  }

  async eval<T>(script: string, keys: string[], args: (string | number)[]): Promise<T> {
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);
    const push = (value: unknown): void => {
      if (value === null || value === undefined) lua.lua_pushnil(L);
      else if (typeof value === 'string') lua.lua_pushstring(L, to_luastring(value));
      else if (typeof value === 'number') lua.lua_pushnumber(L, value);
      else if (typeof value === 'boolean') lua.lua_pushboolean(L, value);
      else {
        lua.lua_newtable(L);
        for (const [key, item] of Object.entries(value)) {
          if (Array.isArray(value)) lua.lua_pushnumber(L, Number(key) + 1);
          else lua.lua_pushstring(L, to_luastring(key));
          push(item); lua.lua_settable(L, -3);
        }
      }
    };
    const read = (index: number): any => {
      const type = lua.lua_type(L, index);
      if (type === lua.LUA_TNIL) return null;
      if (type === lua.LUA_TBOOLEAN) return lua.lua_toboolean(L, index);
      if (type === lua.LUA_TNUMBER) return lua.lua_tonumber(L, index);
      if (type === lua.LUA_TSTRING) return to_jsstring(lua.lua_tolstring(L, index));
      const absolute = lua.lua_absindex(L, index);
      const obj: Record<string, unknown> = {};
      lua.lua_pushnil(L);
      while (lua.lua_next(L, absolute)) { obj[String(read(-2))] = read(-1); lua.lua_pop(L, 1); }
      const names = Object.keys(obj);
      return names.length && names.every((name, i) => name === String(i + 1)) ? Object.values(obj) : obj;
    };
    const register = (name: string, methods: Record<string, () => number>) => {
      lua.lua_newtable(L);
      for (const [key, fn] of Object.entries(methods)) { lua.lua_pushjsfunction(L, fn); lua.lua_setfield(L, -2, to_luastring(key)); }
      lua.lua_setglobal(L, to_luastring(name));
    };
    register('redis', { call: () => {
      const values = Array.from({ length: lua.lua_gettop(L) }, (_, i) => read(i + 1));
      push(this.command(values)); return 1;
    } });
    register('cjson', {
      decode: () => { push(JSON.parse(read(1))); return 1; },
      encode: () => { push(JSON.stringify(read(1))); return 1; },
    });
    push(keys); lua.lua_setglobal(L, to_luastring('KEYS'));
    push(args.map(String)); lua.lua_setglobal(L, to_luastring('ARGV'));
    try {
      if (lauxlib.luaL_loadstring(L, to_luastring(script)) !== lua.LUA_OK || lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) {
        throw new Error(String(read(-1)));
      }
      return read(-1) as T;
    } finally { lua.lua_close(L); }
  }
}
