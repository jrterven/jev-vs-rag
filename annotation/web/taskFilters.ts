import type { Task } from '../shared/types';

export interface TaskFilters {
  status: 'pending' | 'completed' | 'all';
  kind: Task['kind'] | 'all';
  projectId: string;
  documentId: string;
}

export function selectTasks(tasks: Task[], filters: TaskFilters) {
  const scoped = tasks.filter(task => (!filters.projectId || task.projectId === filters.projectId)
    && (!filters.documentId || task.documentId === filters.documentId)
    && (filters.kind === 'all' || task.kind === filters.kind));
  return {
    visible: scoped.filter(task => filters.status === 'all' || (filters.status === 'completed' ? task.status === 'completed' : task.status !== 'completed')),
    total: scoped.length,
    pending: scoped.filter(task => task.status !== 'completed').length,
  };
}

export function taskFilterOptions(tasks: Task[], projectId: string) {
  const projects = new Map<string, { id: string; name: string }>();
  const documents = new Map<string, { id: string; title: string; projectName: string }>();
  for (const task of tasks) {
    const projectName = task.projectName || `Proyecto ${task.projectId.slice(0, 8)}`;
    projects.set(task.projectId, { id: task.projectId, name: projectName });
    if (!projectId || task.projectId === projectId) documents.set(task.documentId, { id: task.documentId, title: task.documentTitle || task.title, projectName });
  }
  return {
    projects: [...projects.values()].sort((a, b) => a.name.localeCompare(b.name, 'es')),
    documents: [...documents.values()].sort((a, b) => a.title.localeCompare(b.title, 'es') || a.projectName.localeCompare(b.projectName, 'es')),
  };
}
