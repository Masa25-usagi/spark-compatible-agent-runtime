import { renderTable } from '../render/table.js';

export async function listSchedules(engine: any) {
  const rows = [['schedule-1', 'Mock Schedule', 'true', '1000']];
  console.log(renderTable(['ID', 'Name', 'Enabled', 'Interval'], rows));
}

export async function createSchedule(engine: any) {
  console.log('Create schedule wizard');
}

export async function pauseSchedule(engine: any, id: string) {
  console.log(`Paused schedule ${id}`);
}

export async function resumeSchedule(engine: any, id: string) {
  console.log(`Resumed schedule ${id}`);
}
