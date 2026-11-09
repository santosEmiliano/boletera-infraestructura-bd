-- Solo en el primer nodo, y solo la primera vez que se forma el grupo.
SET GLOBAL group_replication_bootstrap_group = ON;
START GROUP_REPLICATION;
SET GLOBAL group_replication_bootstrap_group = OFF;
