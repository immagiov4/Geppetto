import { resolve, isAbsolute } from 'node:path';
import { jsonFile, userHome, validateMemory, memoryClassifierDefaults } from './common.mjs';

/** Runtime and readiness resolve the same factory, user and project profile. */
export function memoryClassifierSettings(user, local) {
  return { ...memoryClassifierDefaults, ...user.hooks?.memoryClassifier, ...local.hooks?.memoryClassifier };
}

/** Project settings override user settings, including a legacy single-bucket selection. */
export async function memorySettings(project, home = userHome()) {
  const userFile = resolve(home, '.geppetto/config.json'); const projectFile = resolve(project, '.geppetto/config.json');
  const user = await jsonFile(userFile, {}); const local = await jsonFile(projectFile, {});
  validateMemory(user.memory, userFile); validateMemory(local.memory, projectFile);
  const memory = { ...user.memory, ...local.memory };
  if (!Object.keys(memory).length) return null;
  const selection = local.memory && ('buckets' in local.memory || 'projectBucket' in local.memory) ? local.memory : user.memory;
  const buckets = [...new Set(selection?.buckets ?? (selection?.projectBucket ? [selection.projectBucket] : []))];
  let localPath = memory.localPath ?? null;
  if (localPath) {
    if (/^~[\\/]/.test(localPath)) localPath = resolve(home, localPath.slice(2));
    else if (!isAbsolute(localPath)) localPath = resolve(local.memory?.localPath ? project : home, localPath);
    else localPath = resolve(localPath);
  }
  return { ...memory, localPath, buckets };
}
