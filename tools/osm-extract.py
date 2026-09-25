#!/usr/bin/env python3
"""Bounded-memory OSM XML ingestion and reference-complete geographic selection.

The raw regional extract lives in a disk-backed SQLite index. Only the selected
compiler window becomes JSON. No Overpass, third-party Python packages, or XML
DOM of the whole region is required.
"""
import argparse
import bz2
import gzip
import json
import math
import os
from pathlib import Path
import sqlite3
import sys
import xml.etree.ElementTree as ET

SCHEMA = 3
FEATURE_KEYS = {'building', 'building:part', 'landuse', 'leisure', 'natural',
                'amenity', 'waterway', 'water', 'highway', 'area:highway',
                'historic', 'memorial'}


def osm_stream(path):
    if str(path).endswith('.gz'):
        return gzip.open(path, 'rb')
    if str(path).endswith('.bz2'):
        return bz2.open(path, 'rb')
    return open(path, 'rb')


def index_xml(source, database):
    stat = source.stat()
    identity = json.dumps([SCHEMA, str(source.resolve()), stat.st_size, stat.st_mtime_ns])
    db = sqlite3.connect(database)
    db.execute('PRAGMA cache_size=-32768')  # 32 MiB cache, independent of extract size
    db.execute('PRAGMA temp_store=FILE')
    try:
        prior = db.execute("SELECT value FROM metadata WHERE key='source'").fetchone()
        if prior and prior[0] == identity:
            return db, True
    except sqlite3.OperationalError:
        pass
    db.executescript('''
      DROP TABLE IF EXISTS metadata; DROP TABLE IF EXISTS nodes;
      DROP TABLE IF EXISTS ways; DROP TABLE IF EXISTS refs;
      DROP TABLE IF EXISTS relations; DROP TABLE IF EXISTS members;
      CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE nodes(id INTEGER PRIMARY KEY,lat REAL,lon REAL,data TEXT);
      CREATE TABLE ways(id INTEGER PRIMARY KEY,data TEXT,minlat REAL,minlon REAL,maxlat REAL,maxlon REAL);
      CREATE TABLE refs(way INTEGER,node INTEGER);
      CREATE TABLE relations(id INTEGER PRIMARY KEY,relevant INTEGER,data TEXT,minlat REAL,minlon REAL,maxlat REAL,maxlon REAL);
      CREATE TABLE members(relation INTEGER,type TEXT,ref INTEGER);
    ''')
    count = 0
    with osm_stream(source) as stream:
        iterator = ET.iterparse(stream, events=('start', 'end'))
        try:
            _, root = next(iterator)
        except StopIteration:
            raise ValueError('OSM XML input is empty')
        if root.tag != 'osm':
            raise ValueError('Expected an OSM XML <osm> snapshot, not an .osc change/history file')
        for event, element in iterator:
            if event != 'end' or element.tag not in ('node', 'way', 'relation'):
                continue
            if element.get('visible') == 'false':
                root.remove(element)
                continue
            kind = element.tag
            ident = int(element.attrib['id'])
            if abs(ident) > 9007199254740991:
                raise ValueError(f'OSM {kind} {ident} exceeds the compiler safe integer range')
            tags = {tag.attrib['k']: tag.attrib['v'] for tag in element.findall('tag')}
            data = {'type': kind, 'id': ident}
            if tags:
                data['tags'] = tags
            if kind == 'node':
                lat, lon = float(element.attrib['lat']), float(element.attrib['lon'])
                if not math.isfinite(lat + lon) or not (-90 <= lat <= 90 and -180 <= lon <= 180):
                    raise ValueError(f'Invalid coordinate on node {ident}')
                data.update(lat=lat, lon=lon)
                db.execute('INSERT INTO nodes VALUES(?,?,?,?)', (ident, lat, lon, json.dumps(data, separators=(',', ':'))))
            elif kind == 'way':
                nodes = [int(nd.attrib['ref']) for nd in element.findall('nd')]
                data['nodes'] = nodes
                db.execute('INSERT INTO ways(id,data) VALUES(?,?)', (ident, json.dumps(data, separators=(',', ':'))))
                db.executemany('INSERT INTO refs VALUES(?,?)', ((ident, ref) for ref in nodes))
            else:
                members = [{'type': m.attrib['type'], 'ref': int(m.attrib['ref']), 'role': m.get('role', '')} for m in element.findall('member')]
                data['members'] = members
                # The compiler consumes feature multipolygons, not worldwide
                # archipelagos, administrative boundaries, or route collections.
                relevant = tags.get('type') == 'multipolygon' and (bool(FEATURE_KEYS.intersection(tags)) or tags.get('place') == 'square')
                db.execute('INSERT INTO relations(id,relevant,data) VALUES(?,?,?)', (ident, int(relevant), json.dumps(data, separators=(',', ':'))))
                db.executemany('INSERT INTO members VALUES(?,?,?)', ((ident, m['type'], m['ref']) for m in members))
            # Remove complete top-level entities; child tags/nd/member must survive
            # until their parent is processed, but the root must not retain them.
            root.remove(element)
            count += 1
            if count % 20000 == 0:
                db.commit()
    db.executescript('''
      CREATE INDEX node_lat ON nodes(lat);
      CREATE INDEX refs_way ON refs(way);
      CREATE INDEX refs_node ON refs(node);
      CREATE INDEX members_parent ON members(relation);
      CREATE INDEX members_ref ON members(type,ref);
      CREATE TEMP TABLE extents AS SELECT r.way id,MIN(n.lat) minlat,MIN(n.lon) minlon,
        MAX(n.lat) maxlat,MAX(n.lon) maxlon FROM refs r JOIN nodes n ON n.id=r.node GROUP BY r.way;
      CREATE UNIQUE INDEX extents_id ON extents(id);
      UPDATE ways SET (minlat,minlon,maxlat,maxlon) =
        (SELECT minlat,minlon,maxlat,maxlon FROM extents WHERE extents.id=ways.id);
      DROP TABLE extents;
      CREATE INDEX way_lat ON ways(minlat,maxlat);
      CREATE TEMP TABLE extents AS SELECT m.relation id,MIN(w.minlat) minlat,MIN(w.minlon) minlon,
        MAX(w.maxlat) maxlat,MAX(w.maxlon) maxlon FROM members m JOIN ways w ON w.id=m.ref
        WHERE m.type='way' GROUP BY m.relation;
      CREATE UNIQUE INDEX extents_id ON extents(id);
      UPDATE relations SET (minlat,minlon,maxlat,maxlon) =
        (SELECT minlat,minlon,maxlat,maxlon FROM extents WHERE extents.id=relations.id);
      DROP TABLE extents;
    ''')
    db.execute('INSERT INTO metadata VALUES(?,?)', ('source', identity))
    db.commit()
    return db, False


def extract(db, bounds, output, allow_incomplete=False):
    west, south, east, north = bounds
    db.executescript('''
      CREATE TEMP TABLE sn(id INTEGER PRIMARY KEY);
      CREATE TEMP TABLE sw(id INTEGER PRIMARY KEY);
      CREATE TEMP TABLE sr(id INTEGER PRIMARY KEY);
    ''')
    db.execute('INSERT INTO sn SELECT id FROM nodes WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?', (south, north, west, east))
    # Bounding overlap also finds a way crossing the window with BOTH endpoints
    # outside, or a closed polygon enclosing the entire requested window.
    db.execute('INSERT INTO sw SELECT id FROM ways WHERE minlat<=? AND maxlat>=? AND minlon<=? AND maxlon>=?', (north, south, east, west))
    # A multipart polygon can enclose the window without any member way
    # bounding box intersecting it. Its combined extent must also be tested.
    db.execute('INSERT INTO sr SELECT id FROM relations WHERE relevant=1 AND minlat<=? AND maxlat>=? AND minlon<=? AND maxlon>=?', (north, south, east, west))
    db.execute('''INSERT OR IGNORE INTO sr SELECT DISTINCT r.id FROM relations r JOIN members m ON m.relation=r.id
      WHERE r.relevant=1 AND ((m.type='way' AND m.ref IN sw) OR (m.type='node' AND m.ref IN sn))''')
    # Include parents and all descendants of selected multipolygons. The closure
    # keeps OSM identities/roles intact instead of flattening relation geometry.
    while True:
        previous = db.total_changes
        db.execute("INSERT OR IGNORE INTO sr SELECT m.ref FROM members m JOIN sr ON sr.id=m.relation JOIN relations r ON r.id=m.ref WHERE m.type='relation'")
        db.execute("INSERT OR IGNORE INTO sr SELECT m.relation FROM members m JOIN sr ON sr.id=m.ref JOIN relations r ON r.id=m.relation WHERE m.type='relation' AND r.relevant=1")
        if previous == db.total_changes:
            break
    db.execute("INSERT OR IGNORE INTO sw SELECT m.ref FROM members m JOIN sr ON sr.id=m.relation WHERE m.type='way'")
    db.execute("INSERT OR IGNORE INTO sn SELECT m.ref FROM members m JOIN sr ON sr.id=m.relation WHERE m.type='node'")
    db.execute('INSERT OR IGNORE INTO sn SELECT r.node FROM refs r JOIN sw ON sw.id=r.way')
    missing = {}
    for kind, selection, table in [('nodes', 'sn', 'nodes'), ('ways', 'sw', 'ways'), ('relations', 'sr', 'relations')]:
        missing[kind] = db.execute(f'SELECT COUNT(*) FROM {selection} s LEFT JOIN {table} t ON t.id=s.id WHERE t.id IS NULL').fetchone()[0]
    missing['relationMembers'] = db.execute("SELECT COUNT(*) FROM members m JOIN sr ON sr.id=m.relation LEFT JOIN relations r ON r.id=m.ref WHERE m.type='relation' AND r.id IS NULL").fetchone()[0]
    if any(missing.values()) and not allow_incomplete:
        raise ValueError(f'Extract has missing references: {missing}. Re-extract with osmium extract --strategy smart, or use --allow-incomplete explicitly.')
    counts = {table: db.execute(f'SELECT COUNT(*) FROM {table} t JOIN {selection} s ON s.id=t.id').fetchone()[0]
              for table, selection in [('nodes', 'sn'), ('ways', 'sw'), ('relations', 'sr')]}
    meta = {'version': 0.6, 'generator': 'FLK VI offline OSM importer', 'bounds': bounds,
            'counts': counts, 'missingReferences': missing}
    output.parent.mkdir(parents=True, exist_ok=True)
    pending = output.with_suffix(output.suffix + '.partial')
    try:
        with pending.open('w', encoding='utf8') as stream:
            stream.write(json.dumps(meta, separators=(',', ':'))[:-1] + ',"elements":[')
            comma = ''
            for table, selection in [('nodes', 'sn'), ('ways', 'sw'), ('relations', 'sr')]:
                for (data,) in db.execute(f'SELECT t.data FROM {table} t JOIN {selection} s ON s.id=t.id ORDER BY t.id'):
                    stream.write(comma + data)
                    comma = ','
            stream.write(']}\n')
        os.replace(pending, output)
    finally:
        pending.unlink(missing_ok=True)
    return meta


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--index', required=True, type=Path)
    parser.add_argument('--bounds', required=True, help='west,south,east,north')
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--allow-incomplete', action='store_true')
    args = parser.parse_args()
    bounds = [float(value) for value in args.bounds.split(',')]
    if len(bounds) != 4 or not all(math.isfinite(v) for v in bounds) or not (-180 <= bounds[0] < bounds[2] <= 180 and -90 <= bounds[1] < bounds[3] <= 90):
        raise ValueError('Bounds must be west,south,east,north without crossing the antimeridian')
    args.index.parent.mkdir(parents=True, exist_ok=True)
    if args.index.resolve() in (args.input.resolve(), args.output.resolve()) or args.output.resolve() == args.input.resolve():
        raise ValueError('Input, output, and index must be different files')
    db, reused = index_xml(args.input, args.index)
    try:
        meta = extract(db, bounds, args.output, args.allow_incomplete)
        print(json.dumps({**meta, 'indexReused': reused}))
    finally:
        db.close()


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, ET.ParseError, sqlite3.Error) as error:
        print(f'OSM import failed: {error}', file=sys.stderr)
        sys.exit(1)
