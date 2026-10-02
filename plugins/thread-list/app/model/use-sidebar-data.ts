import { useEffect, useMemo } from "react";
import { atom, useAtom, useAtomValue } from "jotai";
import { useSidebarThreads } from "@bb/plugin/app";
import { sidebarThreadLifecyclesAtom } from "../preferences.js";

interface SectionNameOverride {
  previousName: string;
  name: string;
}

export const sectionNameOverridesAtom = atom<
  ReadonlyMap<string, SectionNameOverride>
>(new Map());

export function resolveSectionName(
  id: string,
  sourceName: string,
  overrides: ReadonlyMap<string, SectionNameOverride>,
): string {
  const override = overrides.get(id);
  return override?.previousName === sourceName ? override.name : sourceName;
}

export function useSidebarProjectName(
  projectId: string | null,
): string | undefined {
  const { projects } = useSidebarThreads();
  return projectId === null
    ? undefined
    : projects.find((project) => project.id === projectId)?.name;
}

export function useSidebarData() {
  const lifecycles = useAtomValue(sidebarThreadLifecyclesAtom);
  const [sectionNameOverrides, setSectionNameOverrides] = useAtom(
    sectionNameOverridesAtom,
  );
  const state = useSidebarThreads({ lifecycles });
  useEffect(() => {
    const settledIds = state.sections
      .filter((section) => {
        const override = sectionNameOverrides.get(section.id);
        return override && override.previousName !== section.name;
      })
      .map((section) => section.id);
    if (settledIds.length === 0) return;
    setSectionNameOverrides((current) => {
      const next = new Map(current);
      for (const id of settledIds) next.delete(id);
      return next;
    });
  }, [state.sections, sectionNameOverrides, setSectionNameOverrides]);
  const sections = useMemo(() => {
    const renamed = state.sections.map((section) => {
      const name = resolveSectionName(
        section.id,
        section.name,
        sectionNameOverrides,
      );
      return name === section.name ? section : { ...section, name };
    });
    return renamed.every((section, index) => section === state.sections[index])
      ? state.sections
      : renamed;
  }, [state.sections, sectionNameOverrides]);
  const threads = useMemo(() => {
    const projectIds = new Set(state.projects.map((project) => project.id));
    return state.threads.every((thread) => projectIds.has(thread.projectId))
      ? state.threads
      : state.threads.filter((thread) => projectIds.has(thread.projectId));
  }, [state.projects, state.threads]);
  return {
    status: state.status,
    threads,
    sections,
    personalProjectId:
      state.projects.find((project) => project.isPersonal)?.id ?? null,
    archived: state.archived,
  };
}
