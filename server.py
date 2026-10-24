import os
import json
import joblib
import shap
import numpy as np
import pandas as pd
from fastapi import FastAPI
from pydantic import BaseModel
from dotenv import load_dotenv

# 1. Load environment variables from .env
load_dotenv()
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")

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
app = FastAPI(title="Waste Classifier API")


class SensorItem(BaseModel):
    weight_g: float
    moisture_pct: float
    metal_signal: float
    transparency: float
    acoustic_hardness: float


@app.post("/predict")
def predict(item: SensorItem):
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
