import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { ProjectStore } from "../src/stores/projects";
import { ConversationStore } from "../src/stores/conversations";
import { ProjectLaunchService } from "../src/project-launch";
import { PersonalEnvironments } from "../src/personal-environments";
import { applyPersonalProjectPresets } from "../src/personal-project-presets";

test("installe les réglages une seule fois, sans exécuter ni écraser une personnalisation", async () => {
  const root = mkdtempSync(join(tmpdir(), "personal-presets-")),
    db = openDb(root);
  const projects = new ProjectStore(db),
    launches = new ProjectLaunchService(db, projects, root);
  const environments = new PersonalEnvironments(
    db,
    projects,
    new ConversationStore(db),
    async () => {
      throw new Error("aucune sonde autorisée");
    },
  );
  try {
    const path = join(root, "helion");
    mkdirSync(path);
    const project = projects.create({ name: "helion", path });
    const custom = launches.save(project.id, {
      name: "Vérifier le projet",
      command: "echo personnalisé",
    });
    expect(
      applyPersonalProjectPresets(db, projects, launches, environments),
    ).toEqual({ projects: 1, commands: 1, environments: 1 });
    expect(launches.list(project.id)).toHaveLength(2);
    expect(launches.get(custom.id).command).toBe("echo personnalisé");
    expect(environments.list(project.id)[0]?.result).toBeNull();
    const generated = launches
      .list(project.id)
      .find((item) => item.id !== custom.id)!;
    launches.delete(generated.id);
    expect(
      applyPersonalProjectPresets(db, projects, launches, environments),
    ).toEqual({ projects: 0, commands: 0, environments: 0 });
    expect(launches.list(project.id)).toHaveLength(1);
  } finally {
    await launches.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ajouter la production ne recrée pas les commandes supprimées de veille-immo', async () => {
  const root=mkdtempSync(join(tmpdir(),'personal-presets-upgrade-')),db=openDb(root);
  const projects=new ProjectStore(db),launches=new ProjectLaunchService(db,projects,root);
  const saved:unknown[]=[];
  const environments={list:()=>[],save:(_project:string,config:unknown)=>{saved.push(config);return 'env'}} as unknown as PersonalEnvironments;
  try {
    const path=join(root,'veille-immo');mkdirSync(path);
    const project=projects.create({name:'veille-immo',path});
    db.query('INSERT INTO settings VALUES (?,?)').run(`personal-project-presets-v1:${project.id}`,JSON.stringify('installed'));
    expect(applyPersonalProjectPresets(db,projects,launches,environments,[]).environments).toBe(0);
    expect(applyPersonalProjectPresets(db,projects,launches,environments,['pupitre-vps'])).toEqual({projects:1,commands:0,environments:1});
    expect(launches.list(project.id)).toHaveLength(0);
    expect(saved).toEqual([expect.objectContaining({type:'ssh-docker',service:'label:coolify.resourceName=veille-immo'})]);
    expect(applyPersonalProjectPresets(db,projects,launches,environments,['pupitre-vps']).environments).toBe(0);
  } finally {await launches.close();db.close();rmSync(root,{recursive:true,force:true})}
});
