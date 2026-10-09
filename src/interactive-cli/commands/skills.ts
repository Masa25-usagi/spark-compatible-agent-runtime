import { renderTable } from '../render/table.js';

export async function listSkills(engine: any) {
  const rows = [['mock-skill', 'Mock Description', 'true']];
  console.log(renderTable(['Name', 'Description', 'Enabled'], rows));
}

export async function createSkill(engine: any) {
  console.log('Create skill wizard');
}

export async function toggleSkill(engine: any, name: string) {
  console.log(`Toggled skill ${name}`);
}

export async function deleteSkill(engine: any, name: string) {
  console.log(`Deleted skill ${name}`);
}
