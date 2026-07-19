from __future__ import annotations

import io
import json
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import pdfplumber
import requests


REPORT_URL = "https://www.hsi.com.hk/static/uploads/contents/en/indexes/report/hsci/con_30Jun26.pdf"
METHODOLOGY_URL = "https://www.hsi.com.hk/static/uploads/contents/en/dl_centre/methodologies/IM_hscie.pdf"
HSICS_URL = "https://www.hsi.com.hk/eng/our-services/hsics"
LANDING_URL = "https://www.hsi.com.hk/eng/indexes/all-indexes/hsci"
API_TEMPLATE = (
    "https://www.hsi.com.hk/api/wsit-hsil-hiip-ea-public-proxy/v1/"
    "dataretrieval/e/constituents/v1?language=eng&indexCode={code}"
)

OUTPUT = Path(__file__).with_name("hk-candidate.json")
NOTES_OUTPUT = Path(__file__).with_name("hk-research-notes.json")


SECTORS = {
    "Energy": {
        "code": "00011.01",
        "name": "能源",
        "tags": ["资源周期", "高股息", "国企集中"],
        "summary": "以大型油气、煤炭公司为核心，盈利和估值对能源价格、产量与股东回报政策较敏感。",
        "traits": [
            ("周期属性", "偏强", "头部成分主要分布于油气与煤炭产业链，通常随商品价格和供需周期波动。"),
            ("集中度", "较高", "前十大成分已覆盖行业指数的大部分权重，少数大型资源公司影响显著。"),
        ],
        "drivers": [("商品价格", "关注原油、天然气和煤炭价格，以及主要公司的产量与成本变化。"), ("股东回报", "大型能源公司的分红、回购与资本开支纪律会影响价值风格表现。")],
        "risks": [("价格回落", "能源价格快速下行会压缩上游盈利和现金流。"), ("政策与资本开支", "税费、环保约束或激进扩产可能改变自由现金流。")],
    },
    "Materials": {
        "code": "00011.02",
        "name": "原材料",
        "tags": ["商品周期", "高波动", "全球需求"],
        "summary": "由金属、矿业及基础材料公司构成，价格弹性较大，往往受全球制造业、基建与库存周期共同驱动。",
        "traits": [("周期属性", "强", "成分公司的利润通常对铜、金、铝等商品价格与加工价差敏感。"), ("波动特征", "较高", "商品价格和全球需求预期变化会较快传导至估值。")],
        "drivers": [("金属价格", "跟踪主要工业金属、贵金属价格和库存变化。"), ("中国与全球需求", "制造业、地产和基建需求会影响材料消耗与盈利预期。")],
        "risks": [("需求转弱", "补库结束或终端需求下降可能引发价格与盈利同步回落。"), ("成本与供给", "能源成本、矿山增产和监管变化可能压缩利润率。")],
    },
    "Industrials": {
        "code": "00011.03",
        "name": "工业",
        "tags": ["制造运输", "资本开支", "订单周期"],
        "summary": "覆盖制造、设备、运输及工业服务，风格介于周期与成长之间，取决于订单、运价和资本开支景气度。",
        "traits": [("景气来源", "多元", "成分横跨设备、航运、物流与工业服务，单一宏观变量难以解释全部表现。"), ("订单敏感度", "较高", "企业订单、运价和固定资产投资往往是重要领先线索。")],
        "drivers": [("资本开支", "制造业设备更新、基建和企业投资会影响订单能见度。"), ("运输与外需", "航运价格、出口订单和全球贸易景气影响相关成分。")],
        "risks": [("订单下修", "需求放缓可能带来产能利用率和利润率下降。"), ("成本与汇率", "原材料、人工及汇率波动可能侵蚀出口制造企业盈利。")],
    },
    "Consumer Discretionary": {
        "code": "00011.12",
        "name": "非必需性消费",
        "tags": ["消费弹性", "平台经济", "成长型"],
        "summary": "包含互联网平台、汽车、零售及休闲消费，通常对居民信心、收入预期和线上消费活跃度更敏感。",
        "traits": [("增长属性", "偏强", "头部成分包含大型平台和品牌消费公司，增长预期与估值变化影响较大。"), ("消费弹性", "较高", "非刚需支出会随就业、收入、财富效应和促消费政策变化。")],
        "drivers": [("消费信心", "就业、收入和促消费政策影响可选商品与服务需求。"), ("平台变现", "用户增长、广告、电商和本地生活变现效率影响大型平台盈利。")],
        "risks": [("需求不及预期", "消费降级或竞争加剧可能压缩收入增速和利润率。"), ("政策与估值", "平台监管、汽车价格战及高估值回撤均可能放大波动。")],
    },
    "Consumer Staples": {
        "code": "00011.13",
        "name": "必需性消费",
        "tags": ["防御消费", "现金流", "品牌渠道"],
        "summary": "主要覆盖食品饮料、日常消费品等较稳定需求，通常比可选消费更防御，但仍受渠道、原料成本和定价能力影响。",
        "traits": [("防御属性", "中等偏强", "产品需求通常较稳定，收入对经济周期的敏感度相对较低。"), ("盈利关键", "定价与成本", "品牌力、渠道效率和原料成本共同决定利润率。")],
        "drivers": [("量价与产品结构", "销量恢复、提价及高毛利产品占比提升可改善盈利。"), ("成本回落", "农产品、包装和运输成本下降有助于利润率修复。")],
        "risks": [("需求与渠道", "渠道库存过高或消费偏弱会拖累去库存和收入。"), ("成本反弹", "原材料价格上升而提价受限会压缩利润率。")],
    },
    "Healthcare": {
        "code": "00011.14",
        "name": "医疗保健业",
        "tags": ["创新成长", "研发驱动", "高波动"],
        "summary": "医药研发、医疗服务与器械公司占比较高，长期受创新和需求驱动，短期对临床、审批、授权交易和政策变化高度敏感。",
        "traits": [("增长来源", "研发与商业化", "重点成分的价值常取决于研发管线、临床结果和产品放量。"), ("波动特征", "较高", "单项临床、审批或授权事件可能显著改变盈利预期。")],
        "drivers": [("临床与审批", "关键临床读出、监管批准和医保准入可能成为重要催化。"), ("授权与商业化", "对外授权、海外合作和核心产品销售决定现金流改善速度。")],
        "risks": [("研发失败", "临床不达预期或审批延期会直接削弱管线估值。"), ("政策与融资", "集采、医保控费和融资环境变化会影响盈利与研发投入。")],
    },
    "Telecommunications": {
        "code": "00011.06",
        "name": "电讯业",
        "tags": ["高股息", "稳定现金流", "防御"],
        "summary": "由大型电信运营商主导，现金流和分红属性较突出，同时受资费、资本开支、云业务及监管政策影响。",
        "traits": [("防御属性", "较强", "基础通信需求和订阅收入相对稳定，盈利可见度通常较高。"), ("集中度", "高", "行业指数主要由少数大型运营商贡献权重。")],
        "drivers": [("ARPU与新业务", "用户价值、云计算和企业数字化业务增长影响收入结构。"), ("资本开支与分红", "网络投资趋稳和自由现金流改善有利于股东回报。")],
        "risks": [("竞争与资费", "价格竞争可能压低ARPU和增量业务利润率。"), ("监管与投入", "监管要求或新一轮网络投资上行可能降低自由现金流。")],
    },
    "Utilities": {
        "code": "00011.07",
        "name": "公用事业",
        "tags": ["防御", "高股息", "利率敏感"],
        "summary": "电力、燃气及公共基础设施公司占主导，收益相对稳定，通常兼具股息和利率敏感特征。",
        "traits": [("现金流", "相对稳定", "受监管或长期资产经营模式使收入可见度通常高于强周期行业。"), ("利率敏感度", "中等偏高", "高股息和资本密集属性使估值容易受无风险利率与融资成本影响。")],
        "drivers": [("电价与燃料成本", "上网电价、燃料成本和利用小时影响发电企业盈利。"), ("利率与分红", "利率回落和稳定派息通常有利于防御价值风格。")],
        "risks": [("监管调整", "电价、回报率或环保政策变化可能改变盈利框架。"), ("融资成本", "资本开支较高，利率上升会增加融资压力。")],
    },
    "Financials": {
        "code": "00011.08",
        "name": "金融业",
        "tags": ["价值高股息", "利率敏感", "信贷周期"],
        "summary": "银行、保险及交易平台权重较大，表现取决于净息差、资产质量、资本市场活跃度和保险投资收益。",
        "traits": [("价值属性", "较强", "大型银行和保险公司通常贡献较高权重，分红与账面价值是重要估值锚。"), ("宏观敏感度", "较高", "利率、信贷需求、资产质量和资本市场波动会共同影响盈利。")],
        "drivers": [("净息差与信贷", "贷款需求、存款成本和利率路径影响银行收入。"), ("资产质量与市场活跃度", "不良生成、保险投资收益及成交活跃度影响不同金融子行业。")],
        "risks": [("信用周期", "地产和企业信用恶化可能推升拨备与资本压力。"), ("利率与市场波动", "利率快速变化或资本市场下跌会影响银行、保险和券商盈利。")],
    },
    "Properties & Construction": {
        "code": "00011.09",
        "name": "地产建筑业",
        "tags": ["利率敏感", "资产负债表", "政策周期"],
        "summary": "覆盖开发商、收租股、REIT及建筑材料服务，利率、融资条件、销售去化和租金是核心变量。",
        "traits": [("利率敏感度", "高", "资产估值与融资成本均会随利率和信用利差变化。"), ("内部差异", "较大", "开发、收租、REIT与建筑链公司的现金流和风险结构不同。")],
        "drivers": [("融资与利率", "融资成本下降和信用环境改善有利于资产重估。"), ("销售与租金", "住宅销售、库存去化、写字楼及零售租金决定经营修复强度。")],
        "risks": [("杠杆与流动性", "高负债企业在销售偏弱时可能面临再融资压力。"), ("需求持续疲弱", "房价、成交和租金下行会压低净资产价值与盈利。")],
    },
    "Information Technology": {
        "code": "00011.10",
        "name": "资讯科技业",
        "tags": ["平台硬科技", "高成长", "估值敏感"],
        "summary": "大型互联网平台、半导体及硬件公司是核心，增长潜力较高，但对产品周期、AI投入、外部限制和估值折现率敏感。",
        "traits": [("成长属性", "强", "平台、半导体和软件业务的盈利预期主要来自技术渗透与产品扩张。"), ("集中度", "较高", "少数大型平台与硬科技公司对指数方向影响明显。")],
        "drivers": [("AI与云计算", "资本开支、模型商业化和云需求决定平台及算力链景气。"), ("半导体与产品周期", "芯片需求、产能利用率和新品节奏影响硬件公司盈利。")],
        "risks": [("估值压缩", "利率上升或增长预期下修会放大高成长资产回撤。"), ("外部限制与竞争", "出口管制、供应链约束及行业竞争可能影响收入和成本。")],
    },
    "Conglomerates": {
        "code": "00011.11",
        "name": "综合企业",
        "tags": ["多元资产", "价值折价", "资本配置"],
        "summary": "由跨行业控股集团构成，单一行业周期解释力较弱，资产组合、资本配置和控股折价更重要。",
        "traits": [("业务结构", "多元", "公司通常同时覆盖基建、消费、资源或金融等多种资产。"), ("估值特征", "控股折价", "市场常以资产净值、分红及资本配置效率衡量其价值。")],
        "drivers": [("资产重估", "核心子公司盈利改善、资产出售或分拆可能推动折价收窄。"), ("股东回报", "提高分红、回购和资本配置透明度可改善估值。")],
        "risks": [("折价扩大", "复杂结构、信息不透明或低回报投资会扩大控股折价。"), ("多周期暴露", "多元业务也可能同时暴露于地产、资源和全球需求下行。")],
    },
}


def clean(value: object) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = text.translate(str.maketrans({"‐": "-", "‑": "-", "−": "-"}))
    return re.sub(r"\s+", " ", text).strip()


def bilingual_name(value: object) -> str:
    text = clean(value)
    match = re.search(r"[\u3400-\u9fff]", text)
    if not match:
        return text
    english = text[: match.start()].strip(" -")
    chinese = text[match.start() :].strip()
    return f"{chinese}（{english}）" if english else chinese


def detect_sector(index_name: str) -> str | None:
    normalized = clean(index_name)
    if "Hang Seng Composite Industry Index" not in normalized:
        return None
    for sector in SECTORS:
        if f"Index - {sector}" in normalized:
            return sector
    return None


def source_list() -> list[dict[str, str]]:
    return [
        {
            "name": "恒生综合指数月末成分表现报告（2026-06-30）",
            "publisher": "恒生指数有限公司",
            "url": REPORT_URL,
            "tier": "official",
            "evidenceClass": "exchange-market-data",
        },
        {
            "name": "恒生综合指数系列编制方法（Version 2.51）",
            "publisher": "恒生指数有限公司",
            "url": METHODOLOGY_URL,
            "tier": "official",
            "evidenceClass": "official-primary",
        },
        {
            "name": "恒生行业分类系统（HSICS）",
            "publisher": "恒生指数有限公司",
            "url": HSICS_URL,
            "tier": "official",
            "evidenceClass": "official-primary",
        },
        {
            "name": "恒生综合指数官方页面",
            "publisher": "恒生指数有限公司",
            "url": LANDING_URL,
            "tier": "official",
            "evidenceClass": "official-primary",
        },
    ]


def main() -> None:
    session = requests.Session()
    session.headers.update({"User-Agent": "Mozilla/5.0", "Referer": LANDING_URL})
    response = session.get(REPORT_URL, timeout=45)
    response.raise_for_status()
    if not response.content.startswith(b"%PDF"):
        raise RuntimeError("Official month-end report did not return a PDF")

    grouped: dict[str, list[dict[str, object]]] = {name: [] for name in SECTORS}
    with pdfplumber.open(io.BytesIO(response.content)) as pdf:
        # The HSCI industry-index section spans PDF pages 39-77 (zero-based 38-76).
        for page in pdf.pages[38:77]:
            for table in page.extract_tables():
                for row in table[2:]:
                    if not row or len(row) < 11:
                        continue
                    sector = detect_sector(row[1])
                    if sector is None:
                        continue
                    try:
                        weight = float(clean(row[10]).replace(",", ""))
                    except ValueError:
                        continue
                    grouped[sector].append(
                        {
                            "code": clean(row[2]),
                            "name": bilingual_name(row[3]),
                            "weightPct": round(weight, 4),
                            "sourceIndexes": [0],
                        }
                    )

    missing = [sector for sector, rows in grouped.items() if not rows]
    if missing:
        raise RuntimeError(f"Missing official component rows for: {missing}")

    verification: dict[str, object] = {}
    sample_data: dict[str, object] = {}
    sectors_output = []
    for english_name, config in SECTORS.items():
        rows = sorted(grouped[english_name], key=lambda item: (-float(item["weightPct"]), str(item["code"])))
        if not 99.0 <= sum(float(item["weightPct"]) for item in rows) <= 101.0:
            raise RuntimeError(f"Unexpected weight sum for {english_name}")

        api_url = API_TEMPLATE.format(code=config["code"])
        api_payload = session.get(api_url, timeout=30).json()
        latest = (api_payload.get("data") or {}).get("constituents") or []
        latest_codes = [f"{int(item['stockCode']):04d}.HK" for item in sorted(latest, key=lambda x: x["weightOrder"])]
        month_end_top_codes = [str(item["code"]) for item in rows[:10]]
        verification[config["code"]] = {
            "apiUrl": api_url,
            "apiTradeDate": (api_payload.get("data") or {}).get("tradeDate"),
            "apiFields": ["stockCode", "stockName", "price", "changePercentage", "weightOrder"],
            "apiWeightFieldPresent": False,
            "monthEndTop10Codes": month_end_top_codes,
            "latestApiTop10Codes": latest_codes,
            "overlapCount": len(set(month_end_top_codes) & set(latest_codes)),
        }
        sample_data[config["code"]] = {
            "sector": config["name"],
            "totalConstituents": len(rows),
            "officialMonthEndTop3": rows[:3],
        }

        sources = source_list()
        traits = [
            {"label": label, "assessment": assessment, "explanation": explanation, "sourceIndexes": [0, 1]}
            for label, assessment, explanation in config["traits"]
        ]
        drivers = [
            {"title": title, "detail": detail, "sourceIndexes": [0, 1]}
            for title, detail in config["drivers"]
        ]
        risks = [
            {"title": title, "detail": detail, "sourceIndexes": [0, 1]}
            for title, detail in config["risks"]
        ]
        sectors_output.append(
            {
                "code": config["code"],
                "name": config["name"],
                "aliases": [english_name],
                "description": (
                    f"恒生综合指数成分股中，按恒生行业分类系统归入{config['name']}的证券组成该行业指数。"
                    "行业归类主要依据公司各业务领域收入；必要时参考利润或资产。"
                ),
                "styleTags": config["tags"],
                "styleSummary": config["summary"],
                "styleTraits": traits,
                "drivers": drivers,
                "risks": risks,
                "constituents": {
                    "asOf": "2026-06-30",
                    "unit": "percent",
                    "scope": (
                        f"月末权重前10只成分股（共{len(rows)}只）"
                        if len(rows) > 10
                        else f"月末全部{len(rows)}只成分股"
                    ),
                    "totalConstituents": len(rows),
                    "weightingMethod": "自由流通调整市值加权，沿用恒生综合指数的Cap Factor，行业指数不另设上限。",
                    "note": "权重为恒生指数公司月末报告直接公布的行业指数内Weighting (%)；不是观潮估算。实时API只提供权重次序，故不把2026-07-17次序伪装成精确占比。官方逐项权重经过四舍五入，全部成分相加时可能与100%存在轻微尾差。",
                    "sourceIndexes": [0, 1],
                    "items": rows[:10],
                },
                "sourceIndexes": [0, 1, 2],
                "sources": sources,
            }
        )

    output = {
        "id": "hk",
        "label": "港股",
        "asOf": "2026-06-30",
        "taxonomy": {
            "owner": "恒生指数有限公司",
            "name": "恒生综合指数行业指数（一级行业）",
            "version": "HSICS current / HSCI methodology 2.51",
            "effectiveDate": "2026-06-30",
        },
        "dataNote": "12 个行业的精确占比来自恒生指数公司 2026-06-30 月末成分报告；2026-07-17 实时接口仅用于核对领先成分顺序，不把顺序伪装成权重。",
        "sectors": sectors_output,
    }
    OUTPUT.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    notes = {
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "evidenceGrade": "official",
        "coverage": {"expectedSectors": 12, "extractedSectors": len(sectors_output)},
        "monthEndReport": {
            "url": REPORT_URL,
            "httpStatus": response.status_code,
            "contentType": response.headers.get("Content-Type"),
            "bytes": len(response.content),
            "asOf": "2026-06-30",
            "fields": [
                "Trade Date",
                "Index",
                "Stock Code",
                "Stock Name",
                "Exchange Listed",
                "Industry",
                "Trading Currency",
                "Closing Price",
                "% Change",
                "Index Point Contribution",
                "Weighting (%)",
            ],
            "unit": "percent",
            "method": "Download official PDF in memory; extract tables from pages 39-77; group exact Industry Index rows; sort official Weighting (%) descending.",
        },
        "sampleData": sample_data,
        "currentApi": {
            "endpointTemplate": API_TEMPLATE,
            "accessedWith": "HTTPS GET, language=eng, one request per official index code",
            "verification": verification,
        },
        "limitations": [
            "The official current constituent API exposes weightOrder, not numerical weight.",
            "Exact numerical weights therefore use the latest public month-end report dated 2026-06-30.",
            "The 2026-07-17 API snapshot is used only to verify that the official leading-constituent ordering remains broadly consistent; it is not used to invent current weights.",
            "Descriptions, style traits, drivers and risks are concise editorial interpretations of the official composition and methodology, not return forecasts.",
        ],
    }
    NOTES_OUTPUT.write_text(json.dumps(notes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
