rs.status().members.forEach((m) => print(m.name.padEnd(12), m.stateStr.padEnd(10), "salud:", m.health));
