-- Where a deed happened and in which realm, whether its memory never fades, and the faction a rival's backlash echoes.
ALTER TABLE world_attitude ADD COLUMN place_id INTEGER REFERENCES world_place(id);
ALTER TABLE world_attitude ADD COLUMN realm_id INTEGER REFERENCES world_realm(id);
ALTER TABLE world_attitude ADD COLUMN permanent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE world_attitude ADD COLUMN rival_of INTEGER REFERENCES world_faction(id);
