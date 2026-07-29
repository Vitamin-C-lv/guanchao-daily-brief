from __future__ import annotations
import importlib.util, json, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
def load(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module
sources = load("market_evidence_sources")
packet = load("market_evidence_packet")

def source(identifier: str, rows: list[dict], status="ready"):
    return {"sourceId":identifier,"datasetId":identifier,"sourceClass":"official","official":True,"requestedAt":"2026-07-29T00:00:00+00:00","completedAt":"2026-07-29T00:00:01+00:00","asOf":rows[-1]["date"] if rows else None,"releasedAt":rows[-1]["date"] if rows else None,"status":status,"sourceUrl":f"https://example.test/{identifier}","rawSha256":"a"*64 if rows else None,"recordCount":len(rows),"parserVersion":"v1","normalizerVersion":"v1","warnings":[],"errorClass":None,"records":rows,"freshnessCalendar":"US_TRADING","maxTradingSessionLag":1,"required":True}

class PipelineTests(unittest.TestCase):
    def rows(self):
        dates=[f"2026-06-{day:02d}" for day in range(1,22)]
        nominal=[{"date":day,"values":{"BC_2YEAR":4+i/100,"BC_10YEAR":4.5+i/100,"BC_30YEAR":5+i/100}} for i,day in enumerate(dates)]
        real=[{"date":day,"values":{"TC_10YEAR":2+i/100}} for i,day in enumerate(dates)]
        return nominal,real
    def test_xml_parsers(self):
        body=b'<feed><entry><NEW_DATE>2026-07-29</NEW_DATE><BC_2YEAR>4.26</BC_2YEAR><BC_10YEAR>4.61</BC_10YEAR><BC_30YEAR>5.09</BC_30YEAR></entry></feed>'
        self.assertEqual(sources._xml_rows(body,("BC_2YEAR","BC_10YEAR","BC_30YEAR"))[0]["values"]["BC_2YEAR"],4.26)
        real=b'<feed><entry><NEW_DATE>2026-07-29</NEW_DATE><TC_10YEAR>2.41</TC_10YEAR></entry></feed>'
        self.assertEqual(sources._xml_rows(real,("TC_10YEAR",))[0]["values"]["TC_10YEAR"],2.41)
    def test_changes_lineage_and_spread(self):
        nominal, real=self.rows(); result=sources.build_treasury({"us-treasury-nominal-xml":source("us-treasury-nominal-xml",nominal),"us-treasury-real-xml":source("us-treasury-real-xml",real)},"2026-06-21")
        self.assertEqual(result["status"],"ready")
        self.assertEqual(result["changesBp"]["nominal2y"]["1d"],1.0)
        self.assertEqual(result["changesBp"]["nominal2y"]["5d"],5.0)
        self.assertEqual(result["changesBp"]["nominal2y"]["20d"],20.0)
        self.assertEqual(result["spread2s10sBp"],50.0); self.assertEqual(result["changesBp"]["spread2s10sBp"]["20d"],0.0)
        self.assertEqual(result["nominalSource"]["sourceId"],"us-treasury-nominal-xml")
        self.assertEqual(result["realSource"]["sourceId"],"us-treasury-real-xml")
    def test_bp_normalization_preserves_yields_and_changes(self):
        nominal=[{"date":f"2026-06-{day:02d}","values":{"BC_2YEAR":4.26+(day-1)*0.001,"BC_10YEAR":4.61+(day-1)*0.001,"BC_30YEAR":5.09+(day-1)*0.001}} for day in range(1,22)]
        real=[{"date":row["date"],"values":{"TC_10YEAR":2.41}} for row in nominal]
        treasury=sources.build_treasury({"us-treasury-nominal-xml":source("us-treasury-nominal-xml",nominal),"us-treasury-real-xml":source("us-treasury-real-xml",real)},"2026-06-21")
        treasury["spread2s10sBp"]=35.00000000000006
        treasury["changesBp"]["nominal2y"]={"1d":0.3333333333333,"5d":-0.6666666666667,"20d":1.234567}
        first=packet.packet("daily","2026-06-21",treasury,[]); second=packet.packet("daily","2026-06-21",treasury,[])
        self.assertEqual(first["treasuryFactor"]["nominal10y"],4.63)
        self.assertEqual(first["treasuryFactor"]["spread2s10sBp"],35)
        self.assertEqual(first["treasuryFactor"]["changesBp"]["nominal2y"],{"1d":0.33,"5d":-0.67,"20d":1.23})
        self.assertEqual(first["writerPacketId"],second["writerPacketId"])
    def test_calendar_and_stale(self):
        self.assertFalse(sources.is_us_trading_day("2026-07-04")); self.assertFalse(sources.is_us_trading_day("2026-07-03")); self.assertEqual(sources.latest_us_trading_day("2026-07-04"),"2026-07-02")
        nominal,real=self.rows(); result=sources.build_treasury({"us-treasury-nominal-xml":source("us-treasury-nominal-xml",nominal),"us-treasury-real-xml":source("us-treasury-real-xml",real)},"2026-07-29")
        self.assertEqual(result["status"],"stale")
    def test_partial_on_mismatched_or_missing_real(self):
        nominal,real=self.rows(); self.assertEqual(sources.build_treasury({"us-treasury-nominal-xml":source("us-treasury-nominal-xml",nominal),"us-treasury-real-xml":source("us-treasury-real-xml",real[:-1])},"2026-06-21")["status"],"partial")
        unavailable=source("us-treasury-real-xml",[],"unavailable"); self.assertEqual(sources.build_treasury({"us-treasury-nominal-xml":source("us-treasury-nominal-xml",nominal),"us-treasury-real-xml":unavailable},"2026-06-21")["status"],"partial")
    def test_catalog_validation(self):
        catalog={"schemaVersion":1,"sources":[{"sourceId":"x","datasetId":"x","market":"US","primaryUrl":"x","sourceClass":"official","official":True,"requiredForDaily":True,"requiredForWeekly":False,"freshnessCalendar":"US_TRADING","maxTradingSessionLag":1,"parserVersion":"v1","normalizerVersion":"v1","enabled":False}]}
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/"catalog.json";path.write_text(json.dumps(catalog),encoding="utf-8");self.assertEqual(sources.load_catalog(path),[])
            catalog["sources"].append(catalog["sources"][0]);path.write_text(json.dumps(catalog),encoding="utf-8")
            with self.assertRaises(ValueError):sources.load_catalog(path)
    def test_packet_identity_and_sources(self):
        nominal,real=self.rows(); treasury=sources.build_treasury({"us-treasury-nominal-xml":source("us-treasury-nominal-xml",nominal),"us-treasury-real-xml":source("us-treasury-real-xml",real)},"2026-06-21"); source_list=[source("us-treasury-nominal-xml",nominal),source("us-treasury-real-xml",real),source("csi-constituents",[],"unavailable")]
        one=packet.packet("daily","2026-06-21",treasury,source_list); two=packet.packet("daily","2026-06-21",treasury,source_list)
        self.assertEqual(one["writerPacketId"],two["writerPacketId"]);self.assertEqual(len(one["sourceIndex"]),3);self.assertEqual(next(f for f in one["facts"] if "real10y" in f["factId"])["sourceId"],"us-treasury-real-xml")
    def test_immutable_run_idempotency(self):
        nominal,real=self.rows(); treasury=sources.build_treasury({"us-treasury-nominal-xml":source("us-treasury-nominal-xml",nominal),"us-treasury-real-xml":source("us-treasury-real-xml",real)},"2026-06-21"); items=[source("us-treasury-nominal-xml",nominal),source("us-treasury-real-xml",real),source("csi-constituents",[],"unavailable")]
        with tempfile.TemporaryDirectory() as temp:
            old_runs,old_packets=packet.RUNS,packet.PACKETS;packet.RUNS=Path(temp)/"runs";packet.PACKETS=Path(temp)/"packets"
            try:
                first=packet.persist("daily","2026-06-21",treasury,items,None,False);second=packet.persist("daily","2026-06-21",treasury,items,None,False)
                self.assertEqual(first["runId"],second["runId"]);self.assertTrue(first["wroteRun"]);self.assertFalse(second["wroteRun"])
            finally:packet.RUNS,packet.PACKETS=old_runs,old_packets

if __name__ == "__main__": unittest.main()
