-- The bundled rules corpus grew: the 2024 Rules Glossary and the Spells-chapter rules now come from the
-- official SRD 5.2.1 PDF in srd/srd-5.2.1/ (scripts/fetch-srd-pdf.py). The seed only runs while no SRD rows
-- exist, so clear the global rows to let seedSrdGlossary refill them on the same open. Campaign glossary rows
-- are untouched.
DELETE FROM glossary_entry WHERE campaign_id IS NULL AND source = 'srd';
