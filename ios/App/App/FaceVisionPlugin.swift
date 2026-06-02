import Foundation
import UIKit
import Vision
import Capacitor

@objc(FaceVisionPlugin)
public class FaceVisionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FaceVisionPlugin"
    public let jsName = "FaceVision"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "detect", returnType: CAPPluginReturnPromise)
    ]

    @objc func detect(_ call: CAPPluginCall) {
        guard let imageString = call.getString("image"),
              let imageData = FaceVisionPlugin.decodeDataUrl(imageString),
              let uiImage = UIImage(data: imageData),
              let cgImage = uiImage.cgImage else {
            call.reject("Invalid image")
            return
        }

        let request = VNDetectFaceLandmarksRequest()
        let handler = VNImageRequestHandler(cgImage: cgImage, orientation: CGImagePropertyOrientation(uiImage.imageOrientation), options: [:])

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try handler.perform([request])
                guard let observations = request.results as? [VNFaceObservation],
                      let face = observations.max(by: { ($0.boundingBox.width * $0.boundingBox.height) < ($1.boundingBox.width * $1.boundingBox.height) }),
                      let landmarks = face.landmarks else {
                    DispatchQueue.main.async { call.resolve(["ok": false, "reason": "no_face", "source": "appleVision"]) }
                    return
                }

                var groups: [String: [[String: Double]]] = [:]
                func add(_ name: String, _ region: VNFaceLandmarkRegion2D?) {
                    guard let region = region, region.pointCount > 0 else { return }
                    groups[name] = FaceVisionPlugin.convert(region.normalizedPoints, in: face.boundingBox)
                }

                add("faceContour", landmarks.faceContour)
                add("leftEye", landmarks.leftEye)
                add("rightEye", landmarks.rightEye)
                add("leftEyebrow", landmarks.leftEyebrow)
                add("rightEyebrow", landmarks.rightEyebrow)
                add("nose", landmarks.nose)
                add("noseCrest", landmarks.noseCrest)
                add("outerLips", landmarks.outerLips)
                add("innerLips", landmarks.innerLips)
                add("medianLine", landmarks.medianLine)

                let allPoints = groups.values.flatMap { $0 }
                DispatchQueue.main.async {
                    call.resolve([
                        "ok": true,
                        "source": "appleVision",
                        "confidence": Double(face.confidence),
                        "boundingBox": [
                            "x": Double(face.boundingBox.origin.x),
                            "y": Double(1.0 - face.boundingBox.origin.y - face.boundingBox.height),
                            "width": Double(face.boundingBox.width),
                            "height": Double(face.boundingBox.height)
                        ],
                        "groups": groups,
                        "landmarks": allPoints
                    ])
                }
            } catch {
                DispatchQueue.main.async { call.reject("Vision failed: \(error.localizedDescription)") }
            }
        }
    }

    private static func decodeDataUrl(_ value: String) -> Data? {
        if let comma = value.firstIndex(of: ",") {
            let b64 = String(value[value.index(after: comma)...])
            return Data(base64Encoded: b64)
        }
        return Data(base64Encoded: value)
    }

    private static func convert(_ points: [CGPoint], in box: CGRect) -> [[String: Double]] {
        return points.map { point in
            let x = box.origin.x + point.x * box.width
            let yBottom = box.origin.y + point.y * box.height
            let yTop = 1.0 - yBottom
            return [
                "x": Double(max(0, min(1, x))),
                "y": Double(max(0, min(1, yTop)))
            ]
        }
    }
}

extension CGImagePropertyOrientation {
    init(_ orientation: UIImage.Orientation) {
        switch orientation {
        case .up: self = .up
        case .upMirrored: self = .upMirrored
        case .down: self = .down
        case .downMirrored: self = .downMirrored
        case .left: self = .left
        case .leftMirrored: self = .leftMirrored
        case .right: self = .right
        case .rightMirrored: self = .rightMirrored
        @unknown default: self = .up
        }
    }
}
