-- A county's legal claim (its catchment), which may outlast the hexes it holds; NULL means it equals hexes_json.
ALTER TABLE world_county ADD COLUMN claim_hexes_json TEXT;
