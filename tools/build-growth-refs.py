#!/usr/bin/env python3
"""Erzeugt growth/who.json und growth/de.json aus den Originaltabellen.

Quellen (einmalig herunterladen, entpacken, Pfade als Argumente übergeben):
  1. WHO-Paket `anthro` (CRAN, offizielle WHO-Implementierung der Child Growth Standards 2006):
     https://cran.r-project.org/package=anthro  -> anthro/R/sysdata.rda
  2. WHO Weight velocity standards 2009, 1-month increments (z-score-Tabellen, xlsx):
     https://www.who.int/tools/child-growth-standards/standards/weight-velocity
     -> ttt-weight-boys-1mon-z.xlsx, ttt-weight-girls-1mon-z.xlsx
  3. R-Paket `childsds` (CRAN, M. Vogel, Uni Leipzig) mit den LMS-Tabellen
     Kromeyer-Hauschild 2001 (kro.ref), KiGGS 2003-2006 (kiggs.ref) und WHO 2007 (who2007.ref):
     https://cran.r-project.org/package=childsds -> childsds/data/*.rda

Aufruf:
  pip install rdata openpyxl
  python3 tools/build-growth-refs.py <anthro-dir> <childsds-dir> <velocity-boys.xlsx> <velocity-girls.xlsx>
"""
import json
import os
import sys
import warnings

import openpyxl
import rdata

warnings.filterwarnings('ignore')

DAYS_PER_YEAR = 365.25
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'growth')


def rows_who(df, sex):
    sub = df[df['sex'] == sex].sort_values('age')
    return [[int(a), float(l), float(m), float(s)] for a, l, m, s in zip(sub['age'], sub['l'], sub['m'], sub['s'])]


def rows_bccg(df, max_years=None):
    out = []
    for a, nu, mu, sigma in zip(df['age'], df['nu'], df['mu'], df['sigma']):
        a = float(a)
        if a < 0:  # Frühgeborenen-Werte nach Gestationsalter (Voigt) gehören nicht in die Kurve ab Geburt
            continue
        if max_years is not None and a > max_years + 1e-9:
            continue
        out.append([round(a * DAYS_PER_YEAR, 2), float(nu), float(mu), float(sigma)])
    return out


def lms_at(df, age):
    sub = df[abs(df['age'] - age) < 1e-6].iloc[0]
    return [float(sub['nu']), float(sub['mu']), float(sub['sigma'])]


def velocity(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.worksheets[0]
    month = 30.4375
    ends = [0, 28, 61] + [round(k * month) for k in range(3, 13)]
    out = []
    i = 0
    for row in ws.iter_rows(min_row=2, values_only=True):
        if not row or row[0] is None:
            continue
        label, l, m, s, delta = row[0], row[1], row[2], row[3], row[4]
        out.append({
            'label': str(label).replace('–', '-').replace(' ', ' '),
            'from_day': ends[i], 'to_day': ends[i + 1],
            'L': float(l), 'M': float(m), 'S': float(s), 'delta': float(delta),
        })
        i += 1
    assert len(out) == 12, path
    return out


def main(anthro_dir, childsds_dir, vel_boys, vel_girls):
    sysdata = rdata.read_rda(os.path.join(anthro_dir, 'R', 'sysdata.rda'))
    wei = sysdata['growthstandards_weianthro']
    leng = sysdata['growthstandards_lenanthro']
    hc = sysdata['growthstandards_hcanthro']

    def ref(name):
        return rdata.read_rda(os.path.join(childsds_dir, 'data', name + '.rda'))[name]

    who07 = ref('who2007.ref')
    kro = ref('kro.ref')
    kiggs = ref('kiggs.ref')

    who = {
        'id': 'who',
        'name': 'WHO',
        'title': 'WHO Child Growth Standards 2006',
        'kind': 'standard',
        'description': 'Vorgabe für gesunde, gestillte Kinder aus 6 Ländern (Brasilien, Ghana, Indien, Norwegen, Oman, USA). Tagesgenau von Geburt bis 5 Jahre.',
        'source': 'WHO Multicentre Growth Reference Study Group. WHO Child Growth Standards. Geneva: WHO, 2006. LMS-Tabellen aus dem WHO-Paket anthro (CRAN). Zunahme: WHO Child Growth Standards: Growth velocity based on weight, length and head circumference, 2009. Erwachsenengröße: WHO Growth Reference 2007, 19 Jahre (de Onis et al., Bull WHO 2007;85:660-7).',
        'lines': [
            {'z': -1.880794, 'label': 'P3'}, {'z': -1.036433, 'label': 'P15'}, {'z': 0, 'label': 'P50'},
            {'z': 1.036433, 'label': 'P85'}, {'z': 1.880794, 'label': 'P97'},
        ],
        'measures': {
            'weight': {'unit': 'kg', 'male': rows_who(wei, 1), 'female': rows_who(wei, 2)},
            'length': {'unit': 'cm', 'male': rows_who(leng, 1), 'female': rows_who(leng, 2)},
            'hc': {'unit': 'cm', 'male': rows_who(hc, 1), 'female': rows_who(hc, 2)},
        },
        'adult_height': {
            'age_years': 19,
            'male': lms_at(who07.refs['height'].params['male'], 19.0),
            'female': lms_at(who07.refs['height'].params['female'], 19.0),
        },
        'velocity': {
            'weight_1mon': {'male': velocity(vel_boys), 'female': velocity(vel_girls)},
        },
    }

    de = {
        'id': 'de',
        'name': 'Deutschland',
        'title': 'Kromeyer-Hauschild 2001 (Gewicht, Länge), KiGGS 2003-2006 (Kopfumfang)',
        'kind': 'reference',
        'description': 'Deutsche Referenz aus 17 Untersuchungen (1985-1999), gemischt ernährte Kinder. Kopfumfang aus KiGGS (Robert Koch-Institut), erst ab 4 Monaten.',
        'source': 'Kromeyer-Hauschild K et al. Perzentile für den Body-mass-Index für das Kindes- und Jugendalter unter Heranziehung verschiedener deutscher Stichproben. Monatsschr Kinderheilkd 2001;149:807-18. Kopfumfang: Neuhauser H et al. Referenzperzentile für anthropometrische Maßzahlen und Blutdruck aus KiGGS 2003-2006. RKI, Berlin 2013. LMS-Tabellen aus dem R-Paket childsds (CRAN).',
        'lines': [
            {'z': -1.880794, 'label': 'P3'}, {'z': -1.281552, 'label': 'P10'}, {'z': 0, 'label': 'P50'},
            {'z': 1.281552, 'label': 'P90'}, {'z': 1.880794, 'label': 'P97'},
        ],
        'measures': {
            'weight': {'unit': 'kg',
                       'male': rows_bccg(kro.refs['weight'].params['male'], 18),
                       'female': rows_bccg(kro.refs['weight'].params['female'], 18)},
            'length': {'unit': 'cm',
                       'male': rows_bccg(kro.refs['height'].params['male'], 18),
                       'female': rows_bccg(kro.refs['height'].params['female'], 18)},
            'hc': {'unit': 'cm',
                   'male': rows_bccg(kiggs.refs['hc'].params['male'], 18),
                   'female': rows_bccg(kiggs.refs['hc'].params['female'], 18)},
        },
        'adult_height': {
            'age_years': 18,
            'male': lms_at(kro.refs['height'].params['male'], 18.0),
            'female': lms_at(kro.refs['height'].params['female'], 18.0),
        },
    }

    os.makedirs(OUT, exist_ok=True)
    for doc in (who, de):
        with open(os.path.join(OUT, doc['id'] + '.json'), 'w', encoding='utf-8') as f:
            json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
            f.write('\n')
        print(doc['id'], {k: len(v['male']) for k, v in doc['measures'].items()})


if __name__ == '__main__':
    if len(sys.argv) != 5:
        sys.exit(__doc__)
    main(*sys.argv[1:])
