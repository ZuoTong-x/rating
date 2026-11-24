-- The primary key already provides a btree on (projectid, packageid).
drop index if exists idx_project_packages_project_package;
