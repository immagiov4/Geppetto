import { resolve, isAbsolute } from 'node:path';
import { jsonFile, userHome, validateMemory } from './common.mjs';
/** Project settings override user settings, including a legacy single-bucket selection. */
export async function memoryConfiguration(project, home = userHome()) {
  const userFile = resolve(home, '.geppetto/config.json'); const projectFile = resolve(project, '.geppetto/config.json');
  const user = await jsonFile(userFile, {}); const local = await jsonFile(projectFile, {});
  const machine = await jsonFile(resolve(home, '.geppetto/machine.json'), {});
  validateMemory(machine.memory, 'machine.json'); validateMemory(user.memory, userFile); validateMemory(local.memory, projectFile);
  const memory = { ...machine.memory, ...user.memory, ...local.memory };
  for (const higher of [user.memory, local.memory]) {
    if ((higher?.repo || higher?.localPath) && !higher.choice) delete memory.choice;
    else if (higher?.choice) memory.choice = higher.choice;
  }
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

export async function memorySettings(project, home = userHome()) {
  const memory = await memoryConfiguration(project, home);
  return ['native', 'none'].includes(memory?.choice) ? null : memory;
}
