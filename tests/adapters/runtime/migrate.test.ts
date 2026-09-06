import { describe, expect, it, vi } from 'vitest';
import { MigrationFailedError, runMigrations } from '../../../src/adapters/runtime/migrate.js';

describe('runMigrations', () => {
  it('does nothing when DATABASE_URL is unset (in-memory storage mode)', () => {
    const runner = vi.fn();
    runMigrations({}, runner);
    expect(runner).not.toHaveBeenCalled();
  });

  it('does nothing when DATABASE_URL is the empty string', () => {
    // `DATABASE_URL= npm test` sets the variable to an empty string, not
    // absent, and the whole suite depends on that still meaning skip.
    const runner = vi.fn();
    runMigrations({ DATABASE_URL: '' }, runner);
    expect(runner).not.toHaveBeenCalled();
  });

  it('runs the migration command when DATABASE_URL is set', () => {
    const runner = vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' });
    runMigrations({ DATABASE_URL: 'postgresql://example/db' }, runner);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith({ DATABASE_URL: 'postgresql://example/db' });
  });

  it('throws MigrationFailedError, not a silent pass, when the command exits non-zero', () => {
    const runner = vi.fn().mockReturnValue({ status: 1, stdout: '', stderr: 'boom' });
    expect(() => runMigrations({ DATABASE_URL: 'postgresql://example/db' }, runner)).toThrow(
      MigrationFailedError,
    );
  });

  it('does not throw when the command exits 0', () => {
    const runner = vi.fn().mockReturnValue({ status: 0, stdout: 'No pending migrations', stderr: '' });
    expect(() => runMigrations({ DATABASE_URL: 'postgresql://example/db' }, runner)).not.toThrow();
  });

  it('names the P3005 baseline procedure when the failure is an unbaselined database', () => {
    const runner = vi
      .fn()
      .mockReturnValue({ status: 1, stdout: '', stderr: 'Error: P3005 The database schema is not empty.' });
    expect(() => runMigrations({ DATABASE_URL: 'postgresql://example/db' }, runner)).toThrow(
      /migrate resolve --applied/,
    );
  });

  it('never logs the DATABASE_URL value, planted or real', () => {
    const secret = 'postgresql://user:s3cr3t-planted@db.example.internal:5432/freeagents';
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const writeErrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const runner = vi.fn().mockReturnValue({ status: 1, stdout: 'connecting...', stderr: 'refused' });
      expect(() => runMigrations({ DATABASE_URL: secret }, runner)).toThrow(MigrationFailedError);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      writeSpy.mockRestore();
      writeErrSpy.mockRestore();
    }

    for (const line of logs) {
      expect(line).not.toContain(secret);
      expect(line).not.toContain('s3cr3t-planted');
    }
  });
});
