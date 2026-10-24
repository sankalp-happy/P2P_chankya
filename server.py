import os
import json
import joblib
import shap
import numpy as np
import pandas as pd
from fastapi import FastAPI, Body
from pydantic import BaseModel, Field
from dotenv import load_dotenv

# 1. Load environment variables from .env
load_dotenv()

# 2. Resolve model and metrics paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
POSSIBLE_MODEL_DIRS = [
    os.path.join(BASE_DIR, "models"),
    os.path.join(BASE_DIR, "P2P_chankya", "models"),
    os.path.join(os.path.dirname(BASE_DIR), "models"),
    "models",
    "P2P_chankya/models"
]

MODEL_PATH = None
METRICS_PATH = None
for d in POSSIBLE_MODEL_DIRS:
    m = os.path.join(d, "waste.joblib")
    j = os.path.join(d, "waste_metrics.json")
    if os.path.exists(m) and os.path.exists(j):
        MODEL_PATH = m
        METRICS_PATH = j
        break

if not MODEL_PATH:
    raise FileNotFoundError("Could not find models/waste.joblib")

# Load model & SHAP explainer
model = joblib.load(MODEL_PATH)
try:
    model.set_params(device="cpu")
except Exception:
    pass

with open(METRICS_PATH, "r", encoding="utf-8") as f:
    metrics = json.load(f)

classes = metrics["classes"]
features = ["weight_g", "moisture_pct", "metal_signal", "transparency", "acoustic_hardness"]
explainer = shap.TreeExplainer(model)

# 3. Simple FastAPI app
app = FastAPI(
    title="Smart-Bin Waste Classifier & Explainability API",
    description="Real-time sensor inference with TreeSHAP feature attributions and Groq LLM explanations.",
    version="1.0.0"
)


class SensorItem(BaseModel):
    weight_g: float = Field(..., description="Weight in grams", examples=[350.0])
    moisture_pct: float = Field(..., description="Moisture percentage (0-100%)", examples=[72.0])
    metal_signal: float = Field(..., description="Metal detector signal (0-100)", examples=[5.0])
    transparency: float = Field(..., description="Optical transparency (0.0-1.0)", examples=[0.12])
    acoustic_hardness: float = Field(..., description="Acoustic impact hardness (0.0-1.0)", examples=[0.10])


# Actual real-world examples for Swagger UI (/docs)
EXAMPLES = {
    "Food Waste (Organic Scrap)": {
        "summary": "Food Waste (Organic Scrap)",
        "description": "High moisture, heavy weight, low hardness and non-metallic.",
        "value": {
            "weight_g": 350.0,
            "moisture_pct": 72.0,
            "metal_signal": 5.0,
            "transparency": 0.12,
            "acoustic_hardness": 0.10
        }
    },
    "Metal (Beverage Can)": {
        "summary": "Metal (Beverage Can)",
        "description": "Extremely high metal signal, dry, resonant acoustic impact.",
        "value": {
            "weight_g": 85.0,
            "moisture_pct": 2.0,
            "metal_signal": 95.0,
            "transparency": 0.04,
            "acoustic_hardness": 0.88
        }
    },
    "Glass (Clear Bottle)": {
        "summary": "Glass (Clear Bottle)",
        "description": "High transparency, heavy mass, hard acoustic impact.",
        "value": {
            "weight_g": 380.0,
            "moisture_pct": 5.0,
            "metal_signal": 8.0,
            "transparency": 0.75,
            "acoustic_hardness": 0.82
        }
    },
    "Plastic (Lightweight Cup)": {
        "summary": "Plastic (Lightweight Cup)",
        "description": "Ultralight, semi-translucent, dry, non-metallic.",
        "value": {
            "weight_g": 25.0,
            "moisture_pct": 4.0,
            "metal_signal": 2.0,
            "transparency": 0.55,
            "acoustic_hardness": 0.40
        }
    },
    "Paper & Cardboard": {
        "summary": "Paper & Cardboard",
        "description": "Opaque, dry, low density, acoustic vibration absorber.",
        "value": {
            "weight_g": 120.0,
            "moisture_pct": 10.0,
            "metal_signal": 4.0,
            "transparency": 0.02,
            "acoustic_hardness": 0.15
        }
    },
    "E-Waste (Component / Board)": {
        "summary": "E-Waste (Component / Board)",
        "description": "Heavy mass, moderate/high metal signal, opaque rigid casing.",
        "value": {
            "weight_g": 620.0,
            "moisture_pct": 5.0,
            "metal_signal": 60.0,
            "transparency": 0.10,
            "acoustic_hardness": 0.58
        }
    }
}


@app.post(
    "/predict",
    summary="Classify Waste Item & Explain with SHAP / Groq",
    response_description="Predicted waste category, confidence, SHAP attribution values, and natural language explanation."
)
def predict(
    item: SensorItem = Body(
        ...,
        openapi_examples=EXAMPLES
    )
):
    # Single row DataFrame
    data = pd.DataFrame([{
        "weight_g": float(item.weight_g),
        "moisture_pct": float(item.moisture_pct),
        "metal_signal": float(item.metal_signal),
        "transparency": float(item.transparency),
        "acoustic_hardness": float(item.acoustic_hardness)
    }])[features]

    # Predict class and confidence
    probs = model.predict_proba(data)[0]
    best_idx = int(np.argmax(probs))
    pred_label = classes[best_idx]
    confidence = float(probs[best_idx])

    # SHAP values for predicted class
    shap_vals = explainer.shap_values(data)
    class_shap = shap_vals[0, :, best_idx]
    shap_dict = {f: round(float(v), 4) for f, v in zip(features, class_shap)}

    # Groq Explanation (using key from .env)
    explanation = None
    api_key = os.environ.get("GROQ_API_KEY")

    if api_key and api_key.strip():
        try:
            from groq import Groq
            client = Groq(api_key=api_key.strip())
            prompt = (
                f"A waste item was classified as '{pred_label}' with {confidence*100:.1f}% confidence.\n"
                f"Sensors: {data.to_dict(orient='records')[0]}\n"
                f"SHAP feature attributions: {shap_dict}\n"
                f"In 2 simple sentences, explain why the model made this prediction using the SHAP values."
            )
            chat = client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=[{"role": "user", "content": prompt}],
                max_tokens=100
            )
            explanation = chat.choices[0].message.content.strip()
        except Exception as e:
            explanation = f"Groq API error: {str(e)}"

    if not explanation:
        # Fallback explanation using top positive SHAP contributor
        top_feature = max(shap_dict, key=lambda k: shap_dict[k])
        explanation = (
            f"The item was classified as {pred_label} ({confidence*100:.1f}% confidence). "
            f"The strongest deciding feature was {top_feature} with a positive SHAP score of +{shap_dict[top_feature]:.2f}."
        )

    return {
        "prediction": {
            "label": pred_label,
            "confidence": round(confidence, 4)
        },
        "shap_values": shap_dict,
        "explanation": explanation
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=False)
