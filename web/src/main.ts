import './styles/base.css';
import './styles/layouts.css';
import './styles/components.css';

import { Router } from './router';
import { renderAppShell } from './components/app-shell';
import { renderDashboard } from './pages/dashboard';
import { renderTasks } from './pages/tasks';
import { renderApprovals } from './pages/approvals';
import { renderSkills } from './pages/skills';
import { renderSchedules } from './pages/schedules';
import { renderAudit } from './pages/audit';
import { renderTaskDetail } from './pages/task-detail';
import { renderHelp } from './pages/help';

const app = document.getElementById('app')!;
app.appendChild(renderAppShell());

const mainContent = document.getElementById('main-content')!;
const router = new Router(mainContent);

router.add(/^\/$/, () => renderDashboard());
router.add(/^\/tasks$/, () => renderTasks());
router.add(/^\/tasks\/(?<id>[a-zA-Z0-9_-]+)$/, (params) => renderTaskDetail(params.id));
router.add(/^\/approvals$/, () => renderApprovals());
router.add(/^\/skills$/, () => renderSkills());
router.add(/^\/schedules$/, () => renderSchedules());
router.add(/^\/audit$/, () => renderAudit());
router.add(/^\/help$/, () => renderHelp());

router.handleRoute();
