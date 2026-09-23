import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadNexusConfiguration, loadProjectConfiguration } from '../src/configuration/index.js';
import { nexusConfiguration, projectConfiguration } from './support/configuration.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-configuration-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('configuration files', () => {
  it('loads each file and resolves relative paths against its own directory', async () => {
    const root = await temporaryDirectory();
    const projectDirectory = path.join(root, 'project');
    const installationDirectory = path.join(root, 'installation');
    await mkdir(projectDirectory);
    await mkdir(installationDirectory);
    const projectPath = path.join(projectDirectory, 'project.config.json');
    const nexusPath = path.join(installationDirectory, 'nexus.config.json');
    const projectSettings = projectConfiguration();
    projectSettings.preparation = [{ executable: './bin/prepare', args: ['ci'] }];
    const nexusSettings = nexusConfiguration();
    nexusSettings.agentRuntime.provider.executable = './bin/codex';
    await writeFile(projectPath, JSON.stringify(projectSettings));
    await writeFile(nexusPath, JSON.stringify(nexusSettings));

    const project = await loadProjectConfiguration(projectPath);
    const nexus = await loadNexusConfiguration(nexusPath);

    expect(project.repository.source).toBe(path.join(projectDirectory, 'repository.git'));
    expect(project.preparation).toEqual([
      { executable: path.join(projectDirectory, 'bin', 'prepare'), args: ['ci'] },
    ]);
    expect(nexus.workflow.path).toBe(
      path.join(installationDirectory, 'workflows', 'finite-delivery.ts'),
    );
    expect(nexus.storage.root).toBe(path.join(installationDirectory, 'state'));
    expect(nexus.agentRuntime.provider.executable).toBe(
      path.join(installationDirectory, 'bin', 'codex'),
    );
  });

  it('creates a new settings value on reload without mutating the earlier one', async () => {
    const root = await temporaryDirectory();
    const projectPath = path.join(root, 'project.config.json');
    await writeFile(projectPath, JSON.stringify(projectConfiguration()));

    const first = await loadProjectConfiguration(projectPath);

    const changed = projectConfiguration();
    changed.delivery.baseBranch = 'trunk';
    await writeFile(projectPath, JSON.stringify(changed));
    const second = await loadProjectConfiguration(projectPath);

    expect(second).not.toBe(first);
    expect(second.delivery.baseBranch).toBe('trunk');
    expect(first.delivery.baseBranch).toBe('main');
  });

  it('reports an unreadable configuration file', async () => {
    const root = await temporaryDirectory();
    const missingPath = path.join(root, 'missing.json');

    await expect(loadProjectConfiguration(missingPath)).rejects.toThrow(
      /Cannot read project configuration .*missing\.json/,
    );
  });

  it('reports invalid JSON', async () => {
    const root = await temporaryDirectory();
    const nexusPath = path.join(root, 'nexus.config.json');
    await writeFile(nexusPath, '{ not json');

    await expect(loadNexusConfiguration(nexusPath)).rejects.toThrow(
      /Nexus configuration .* is not valid JSON/,
    );
  });

  it('reports invalid settings with their location and file', async () => {
    const root = await temporaryDirectory();
    const projectPath = path.join(root, 'project.config.json');
    const configuration = projectConfiguration();
    configuration.delivery.completion.waitLimitSeconds = -1;
    await writeFile(projectPath, JSON.stringify(configuration));

    await expect(loadProjectConfiguration(projectPath)).rejects.toThrow(
      /Invalid project configuration .*project\.config\.json: .*delivery\.completion\.waitLimitSeconds/,
    );
  });
});
