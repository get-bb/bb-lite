ALTER TABLE environments ADD COLUMN workspace_provision_type TEXT;
UPDATE environments SET workspace_provision_type = CASE environment_provider_id
  WHEN 'git-worktree' THEN 'managed-worktree'
  WHEN 'personal-workspace' THEN 'personal'
  WHEN 'project-checkout' THEN 'unmanaged'
END;
