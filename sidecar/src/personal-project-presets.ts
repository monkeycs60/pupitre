import { basename } from "node:path";
import type { Database } from "bun:sqlite";
import profiles from "../../config/personal-projects.json";
import type { ProjectStore } from "./stores/projects";
import type { ProjectLaunchService, LaunchCommand } from "./project-launch";
import type {
  PersonalEnvironments,
  EnvironmentConfig,
} from "./personal-environments";

export function applyPersonalProjectPresets(
  db: Database,
  projects: ProjectStore,
  launches: ProjectLaunchService,
  environments: PersonalEnvironments,
): { projects: number; commands: number; environments: number } {
  const counts = { projects: 0, commands: 0, environments: 0 };
  for (const profile of profiles) {
    const project = projects
      .list()
      .find(
        (item) =>
          item.name === profile.project &&
          basename(item.path) === profile.project,
      );
    if (!project) continue;
    const key = `personal-project-presets-v1:${project.id}`;
    if (db.query("SELECT 1 FROM settings WHERE key=?").get(key)) continue;
    db.transaction(() => {
      const existingCommands = launches.list(project.id);
      for (const command of profile.commands) {
        if (existingCommands.some((item) => item.name === command.name))
          continue;
        launches.save(project.id, command as Partial<LaunchCommand>);
        counts.commands++;
      }
      const existingEnvironments = environments.list(project.id);
      for (const environment of profile.environments) {
        if (
          existingEnvironments.some(
            (item) => item.config.name === environment.name,
          )
        )
          continue;
        environments.save(project.id, environment as EnvironmentConfig);
        counts.environments++;
      }
      db.query("INSERT INTO settings(key,value) VALUES (?,?)").run(
        key,
        JSON.stringify(new Date().toISOString()),
      );
      counts.projects++;
    })();
  }
  return counts;
}
