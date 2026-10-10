let reload = (): void => {};

export function onPluginsChanged(run: () => void): void {
  reload = run;
}

export function pluginsChanged(): void {
  reload();
}
